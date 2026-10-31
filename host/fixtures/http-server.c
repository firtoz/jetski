/* MIT licensed. Disposable single-request qualification fixture, not installed. */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

int main(void) {
    int server = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    struct sockaddr_in address = { .sin_family = AF_INET, .sin_port = htons(18080) };
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (server < 0 || bind(server, (struct sockaddr *)&address, sizeof(address)) || listen(server, 1)) return 1;
    int ready = open("/tmp/jetski-http-ready", O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    if (ready < 0) return 1;
    close(ready);
    int connection = accept4(server, NULL, NULL, SOCK_CLOEXEC);
    close(server);
    if (connection < 0) return 1;
    const char expected[] = "GET / HTTP/1.0\r\nHost: localhost\r\n\r\n";
    unsigned char request[1024];
    size_t size = 0;
    for (;;) {
        if (size == sizeof(request)) return 1;
        ssize_t count = read(connection, request + size, sizeof(request) - size);
        if (count == 0) break;
        if (count < 0) { if (errno == EINTR) continue; return 1; }
        size += (size_t)count;
    }
    if (size != sizeof(expected) - 1 || memcmp(request, expected, size)) return 1;
    const char response[] = "HTTP/1.0 200 OK\r\nContent-Length: 15\r\n\r\nrelay-container";
    size_t sent = 0;
    while (sent < sizeof(response) - 1) {
        ssize_t count = send(connection, response + sent, sizeof(response) - 1 - sent, MSG_NOSIGNAL);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return 1;
        sent += (size_t)count;
    }
    close(connection);
    int complete = open("/tmp/jetski-http-complete", O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    if (complete < 0) return 1;
    close(complete);
    /* Keep PID 1 alive until the owned fixture is removed; otherwise the runtime
     * would kill the relay exec while it is draining the response and FIN. */
    for (;;) pause();
}
