/* MIT licensed. Linux command-tree supervisor, independent of workload libc.
 * It adopts orphaned descendants and reaps all children before returning.
 * SIGKILL/host failure are uncertain outcomes, never successful cancellation.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <stdint.h>

static volatile sig_atomic_t cancelling = 0;
static void cancel(int signo) { (void)signo; cancelling = 1; }

static int kill_children(void) {
    char path[128];
    snprintf(path, sizeof(path), "/proc/self/task/%ld/children", (long)getpid());
    FILE *children = fopen(path, "re");
    if (!children) return -1;
    long pid;
    int count = 0;
    while (fscanf(children, "%ld", &pid) == 1) {
        if (pid <= 1 || pid > 2147483647L || ++count > 4096) {
            fclose(children);
            return -1;
        }
        /* Only this thread reaps. Every listed PID is our unreaped child, so
         * even a concurrent exit cannot recycle that PID before this signal.
         * Killing parents reparents their descendants to this subreaper; the
         * next iteration handles those, including setsid/double-fork children.
         */
        if (kill((pid_t)pid, SIGKILL) && errno != ESRCH) {
            fclose(children);
            return -1;
        }
    }
    int failed = ferror(children);
    fclose(children);
    return failed ? -1 : 0;
}

/* Terminal control stays on private attach stdin, outside the workload PTY.
 * Frames: I + uint32be length + bytes; R + length4 + uint16be rows/cols;
 * S + length1 + SIGINT/SIGQUIT/SIGTSTP; C + length0 requests tree cleanup.
 * No frame is retried here. The host must fence and journal input delivery.
 */
struct terminal {
    int master;
    int eof;
    unsigned char frame[65541];
    size_t have;
    unsigned char pending[65536];
    size_t used, sent;
};

static int write_all(int fd, const unsigned char *bytes, size_t size) {
    while (size) {
        ssize_t n = write(fd, bytes, size);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return -1;
        bytes += n;
        size -= (size_t)n;
    }
    return 0;
}

static int terminal_pump(struct terminal *term) {
    unsigned char output[16384];
    /* Bounded per iteration so a noisy workload cannot starve cancellation. */
    for (int i = 0; i < 16 && !term->eof; i++) {
        ssize_t n = read(term->master, output, sizeof(output));
        if (n > 0) {
            if (write_all(STDOUT_FILENO, output, (size_t)n)) return -1;
        } else if (n == 0 || (n < 0 && errno == EIO)) term->eof = 1;
        else if (errno == EAGAIN || errno == EINTR) break;
        else return -1;
    }
    if (term->sent < term->used) {
        ssize_t n = write(term->master, term->pending + term->sent, term->used - term->sent);
        if (n > 0) term->sent += (size_t)n;
        else if (n < 0 && errno != EAGAIN && errno != EINTR) return -1;
        if (term->sent < term->used) return 0;
        term->used = term->sent = 0;
    }
    /* Read precisely one frame; do not consume the next input before applying it. */
    size_t need = 5;
    if (term->have >= 5) {
        uint32_t size = ((uint32_t)term->frame[1] << 24) |
            ((uint32_t)term->frame[2] << 16) | ((uint32_t)term->frame[3] << 8) | term->frame[4];
        if (size > 65536) return -1;
        need += size;
    }
    if (term->have < need) {
        ssize_t n = read(STDIN_FILENO, term->frame + term->have, need - term->have);
        if (n > 0) term->have += (size_t)n;
        else if (n == 0) { cancelling = 1; return 0; }
        else if (errno != EAGAIN && errno != EINTR) return -1;
        return 0;
    }
    size_t size = need - 5;
    unsigned char *data = term->frame + 5;
    switch (term->frame[0]) {
        case 'I':
            if (!size) return -1;
            memcpy(term->pending, data, size);
            term->used = size;
            break;
        case 'R': {
            if (size != 4) return -1;
            struct winsize dimensions = {0};
            dimensions.ws_row = ((unsigned)data[0] << 8) | data[1];
            dimensions.ws_col = ((unsigned)data[2] << 8) | data[3];
            if (!dimensions.ws_row || !dimensions.ws_col || dimensions.ws_row > 4096 || dimensions.ws_col > 4096) return -1;
            if (ioctl(term->master, TIOCSWINSZ, &dimensions)) return -1;
            break;
        }
        case 'S':
            if (size != 1 || (data[0] != SIGINT && data[0] != SIGQUIT && data[0] != SIGTSTP)) return -1;
            /* Kernel targets the PTY foreground group; never race a userspace PID lookup. */
            if (ioctl(term->master, TIOCSIG, (int)data[0])) return -1;
            break;
        case 'C':
            if (size) return -1;
            cancelling = 1;
            break;
        default: return -1;
    }
    term->have = 0;
    return 0;
}

static int dimension(const char *value) {
    unsigned result = 0;
    if (!*value) return -1;
    for (; *value; value++) {
        if (*value < '0' || *value > '9') return -1;
        result = result * 10 + (unsigned)(*value - '0');
        if (result > 4096) return -1;
    }
    return result ? (int)result : -1;
}

int main(int argc, char **argv) {
    if (argc < 3) return 125;
    if (prctl(PR_SET_CHILD_SUBREAPER, 1) || prctl(PR_SET_DUMPABLE, 0)) return 125;
    struct sigaction action = {0};
    action.sa_handler = cancel;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGTERM, &action, NULL) || sigaction(SIGINT, &action, NULL)) return 125;
    unsigned char nonce[32];
    size_t received = 0;
    while (received < sizeof(nonce)) {
        ssize_t n = read(STDIN_FILENO, nonce + received, sizeof(nonce) - received);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return 125;
        received += (size_t)n;
    }
    int interactive = strcmp(argv[1], "--jetski-pty-v1") == 0;
    if (!interactive && strcmp(argv[1], "--jetski-exec-v1") != 0) return 125;
    if (interactive && argc < 5) return 125;
    int rows = interactive ? dimension(argv[2]) : 24;
    int columns = interactive ? dimension(argv[3]) : 80;
    if (rows < 0 || columns < 0) return 125;
    struct terminal term = {.master = -1};
    char slave_path[128];
    int slave = -1;
    if (interactive) {
        term.master = posix_openpt(O_RDWR | O_NOCTTY | O_CLOEXEC | O_NONBLOCK);
        if (term.master < 0 || grantpt(term.master) || unlockpt(term.master) ||
            ptsname_r(term.master, slave_path, sizeof(slave_path))) return 125;
        struct winsize dimensions = {.ws_row = (unsigned short)rows, .ws_col = (unsigned short)columns};
        if (ioctl(term.master, TIOCSWINSZ, &dimensions)) return 125;
        slave = open(slave_path, O_RDWR | O_NOCTTY | O_CLOEXEC);
        if (slave < 0) return 125;
    }
    pid_t leader = fork();
    if (leader < 0) return 125;
    if (leader == 0) {
        explicit_bzero(nonce, sizeof(nonce));
        signal(SIGTERM, SIG_DFL);
        signal(SIGINT, SIG_DFL);
        if (setsid() < 0) _exit(125);
        if (interactive) {
            close(term.master);
            if (ioctl(slave, TIOCSCTTY, 0)) _exit(125);
            for (int fd = 0; fd < 3; fd++) if (dup2(slave, fd) < 0) _exit(125);
            if (slave > 2) close(slave);
        } else {
            int null_input = open("/dev/null", O_RDONLY);
            if (null_input < 0 || dup2(null_input, STDIN_FILENO) < 0) _exit(125);
            if (null_input != STDIN_FILENO) close(null_input);
        }
        execvp(argv[interactive ? 4 : 2], argv + (interactive ? 4 : 2));
        _exit(127);
    }
    if (interactive) close(slave);
    if (interactive && fcntl(STDIN_FILENO, F_SETFL, fcntl(STDIN_FILENO, F_GETFL) | O_NONBLOCK)) return 125;
    int leader_result = 125;
    for (;;) {
        if (interactive && terminal_pump(&term)) return 125;
        if (cancelling && kill_children()) {
            /* Fail closed: remain alive rather than claim the tree is clean.
             * The host must quarantine on timeout or forced supervisor death.
             */
            struct timespec delay = {0, 10000000};
            nanosleep(&delay, NULL);
            continue;
        }
        int status;
        pid_t child;
        while ((child = waitpid(-1, &status, WNOHANG)) > 0) {
            if (child == leader) {
                if (WIFEXITED(status)) leader_result = WEXITSTATUS(status);
                else if (WIFSIGNALED(status)) leader_result = 128 + WTERMSIG(status);
            }
        }
        if (child < 0 && errno == ECHILD) {
            if (interactive && !term.eof) continue;
            if (interactive) close(term.master);
            /* The nonce arrived only after dumpability was disabled, via the
             * private attach input, and was erased from the child before exec.
             * Only this supervisor can authenticate the final cleanup receipt.
             */
            char hex[65];
            for (size_t i = 0; i < sizeof(nonce); i++) snprintf(hex + i * 2, 3, "%02x", nonce[i]);
            int result = cancelling ? 143 : leader_result;
            if (write(STDERR_FILENO, "\0", 1) != 1 ||
                dprintf(STDERR_FILENO, "jetski-complete-v1:%s:%d:%03d", hex, !!cancelling, result) < 0 ||
                write(STDERR_FILENO, "\0", 1) != 1) return 125;
            explicit_bzero(nonce, sizeof(nonce));
            return result;
        }
        if (child < 0 && errno != EINTR) return 125;
        struct timespec delay = {0, 10000000};
        nanosleep(&delay, NULL);
    }
}
