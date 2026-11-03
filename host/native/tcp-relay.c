/* MIT licensed. Workload-local TCP relay; no DNS, host paths or subprocesses.
 * Protocol v1: tag + uint32be length + payload. Input D(data), F(write FIN).
 * Output R(connected), D(data), F(read FIN). Control frames have zero length.
 * Transport EOF before input FIN is uncertainty, never permission to reconnect.
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#define FRAME_BYTES 16384
#define CONNECT_SECONDS 5
#define LIFETIME_SECONDS 3600
static int relay_error(int stage) {
    int error = errno;
    fprintf(stderr, "JETSKI-RELAY/1 failure stage=%d errno=%d\n", stage, error);
    return 125;
}
static volatile sig_atomic_t interrupted;
static void interrupt(int signal_number) { (void)signal_number; interrupted = 1; }
static double monotonic(void) {
    struct timespec time;
    if (clock_gettime(CLOCK_MONOTONIC, &time)) return -1;
    return (double)time.tv_sec + (double)time.tv_nsec / 1000000000.0;
}
static int nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL);
    return flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0;
}
static void header(unsigned char *buffer, unsigned char tag, size_t length) {
    uint32_t size = htonl((uint32_t)length);
    buffer[0] = tag;
    memcpy(buffer + 1, &size, 4);
}
static int transient(void) { return errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR; }

int main(int argc, char **argv) {
    if (argc != 3 || strcmp(argv[1], "--jetski-tcp-v1")) return relay_error(__LINE__);
    if (!argv[2][0] || strlen(argv[2]) > 5) return relay_error(__LINE__);
    for (const char *at = argv[2]; *at; at++) if (*at < '0' || *at > '9') return relay_error(__LINE__);
    char *end;
    long port = strtol(argv[2], &end, 10);
    if (*end || port < 1 || port > 65535) return relay_error(__LINE__);
    if (prctl(PR_SET_DUMPABLE, 0) || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) return relay_error(__LINE__);
    signal(SIGPIPE, SIG_IGN);
    signal(SIGTERM, interrupt);
    signal(SIGINT, interrupt);
    int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    if (fd < 0) return relay_error(__LINE__);
    struct sockaddr_in address = { .sin_family = AF_INET, .sin_port = htons((uint16_t)port) };
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    double started = monotonic();
    if (started < 0) return relay_error(__LINE__);
    if (connect(fd, (struct sockaddr *)&address, sizeof(address))) {
        if (errno != EINPROGRESS) return relay_error(__LINE__);
        for (;;) {
            if (interrupted || monotonic() - started >= CONNECT_SECONDS) return relay_error(__LINE__);
            struct pollfd connect_poll = { .fd = fd, .events = POLLOUT };
            int ready = poll(&connect_poll, 1, 100);
            if (ready < 0 && errno != EINTR) return relay_error(__LINE__);
            if (ready > 0) {
                int error = 0;
                socklen_t length = sizeof(error);
                if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length) || error) return relay_error(__LINE__);
                break;
            }
        }
    }
    if (nonblocking(STDIN_FILENO) || nonblocking(STDOUT_FILENO)) return relay_error(__LINE__);
    unsigned char input[FRAME_BYTES + 5], output[FRAME_BYTES + 5];
    size_t have = 0, wanted = 5, sent = 0;
    size_t output_size = 5, output_sent = 0;
    int input_complete = 0, write_fin = 0, read_fin = 0, emitted_fin = 0;
    header(output, 'R', 0);
    for (;;) {
        double now = monotonic();
        if (interrupted || now < 0 || now - started >= LIFETIME_SECONDS) return relay_error(__LINE__);
        if (output_sent == output_size) {
            output_sent = output_size = 0;
            if (read_fin && !emitted_fin) {
                header(output, 'F', 0);
                output_size = 5;
                emitted_fin = 1;
            }
        }
        if (write_fin && read_fin && emitted_fin && output_size == 0) { close(fd); return 0; }
        struct pollfd poll_fds[3] = {
            { .fd = STDIN_FILENO, .events = (!write_fin && !input_complete) ? POLLIN : 0 },
            { .fd = STDOUT_FILENO, .events = output_sent < output_size ? POLLOUT : 0 },
            { .fd = fd, .events = ((!read_fin && output_size == 0) ? POLLIN : 0) | ((input_complete && input[0] == 'D') ? POLLOUT : 0) }
        };
        /* Exclude idle descriptors: HUP would otherwise cause a busy loop. */
        for (int i = 0; i < 3; i++) if (!poll_fds[i].events) poll_fds[i].fd = -1;
        int ready = poll(poll_fds, 3, 100);
        if (ready < 0) { if (errno == EINTR) continue; return relay_error(__LINE__); }
        if (poll_fds[1].revents & (POLLERR | POLLHUP | POLLNVAL)) return relay_error(__LINE__);
        if (poll_fds[1].revents & POLLOUT) {
            ssize_t count = write(STDOUT_FILENO, output + output_sent, output_size - output_sent);
            if (count > 0) output_sent += (size_t)count;
            else if (count < 0 && !transient()) return relay_error(__LINE__);
        }
        if (poll_fds[0].revents & (POLLIN | POLLHUP)) {
            ssize_t count = read(STDIN_FILENO, input + have, wanted - have);
            if (count == 0) return relay_error(__LINE__);
            if (count < 0) { if (!transient()) return relay_error(__LINE__); }
            else {
                have += (size_t)count;
                if (have == 5 && wanted == 5) {
                    uint32_t length;
                    memcpy(&length, input + 1, 4);
                    length = ntohl(length);
                    if ((input[0] == 'D' && (length < 1 || length > FRAME_BYTES)) ||
                        (input[0] == 'F' && length != 0) || (input[0] != 'D' && input[0] != 'F')) return relay_error(__LINE__);
                    wanted = (size_t)length + 5;
                }
                if (have == wanted) { input_complete = 1; sent = 5; }
            }
        }
        if (poll_fds[0].revents & (POLLERR | POLLNVAL)) return relay_error(__LINE__);
        if (input_complete && input[0] == 'F') {
            if (shutdown(fd, SHUT_WR)) return relay_error(__LINE__);
            write_fin = 1;
            input_complete = 0;
        } else if (input_complete && (poll_fds[2].revents & POLLOUT)) {
            ssize_t count = send(fd, input + sent, wanted - sent, MSG_NOSIGNAL);
            if (count > 0) {
                sent += (size_t)count;
                if (sent == wanted) { input_complete = 0; have = 0; wanted = 5; }
            } else if (count < 0 && !transient()) return relay_error(__LINE__);
        }
        if (!read_fin && output_size == 0 && (poll_fds[2].revents & (POLLIN | POLLHUP))) {
            ssize_t count = recv(fd, output + 5, FRAME_BYTES, 0);
            if (count == 0) read_fin = 1;
            else if (count > 0) { header(output, 'D', (size_t)count); output_size = (size_t)count + 5; }
            else if (!transient()) return relay_error(__LINE__);
        }
        if (poll_fds[2].revents & (POLLERR | POLLNVAL)) return relay_error(__LINE__);
    }
}
