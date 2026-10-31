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

int main(int argc, char **argv) {
    if (argc < 2) return 125;
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
    pid_t leader = fork();
    if (leader < 0) return 125;
    if (leader == 0) {
        explicit_bzero(nonce, sizeof(nonce));
        int null_input = open("/dev/null", O_RDONLY);
        if (null_input < 0 || dup2(null_input, STDIN_FILENO) < 0) _exit(125);
        if (null_input != STDIN_FILENO) close(null_input);
        signal(SIGTERM, SIG_DFL);
        signal(SIGINT, SIG_DFL);
        if (setsid() < 0) _exit(125);
        execvp(argv[1], argv + 1);
        _exit(127);
    }
    int leader_result = 125;
    for (;;) {
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
