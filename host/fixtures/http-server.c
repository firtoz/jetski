/* MIT licensed. Disposable single-request qualification fixture, not installed. */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static int send_response(int connection) {
    const char response[] = "HTTP/1.0 200 OK\r\nContent-Length: 15\r\n\r\nrelay-container";
    size_t sent = 0;
    while (sent < sizeof(response) - 1) {
        ssize_t count = send(connection, response + sent, sizeof(response) - 1 - sent, MSG_NOSIGNAL);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return 1;
        sent += (size_t)count;
    }
    return 0;
}
int main(int argc, char **argv) {
    int half = argc == 2 && !strcmp(argv[1], "--half");
    int preview = argc == 2 && !strcmp(argv[1], "--preview-http");
    int websocket = argc == 2 && !strcmp(argv[1], "--preview-ws");
    if (argc != 1 && !half && !preview && !websocket) return 1;
    int server = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    struct sockaddr_in address = { .sin_family = AF_INET, .sin_port = htons(18080) };
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    int reuse = 1;
    if (server < 0 || setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse))) return 1;
    if (server < 0 || bind(server, (struct sockaddr *)&address, sizeof(address)) || listen(server, 1)) return 1;
    int ready = open("/tmp/jetski-http-ready", O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    if (ready < 0) return 1;
    close(ready);
    int connection = accept4(server, NULL, NULL, SOCK_CLOEXEC);
    close(server);
    if (connection < 0) return 1;
    if (half && (send_response(connection) || shutdown(connection, SHUT_WR))) return 1;
    const char expected[] = "GET / HTTP/1.0\r\nHost: localhost\r\n\r\n";
    unsigned char request[1024] = {0};
    size_t size = 0;
    for (;;) {
        if (size == sizeof(request) - 1) return 1;
        ssize_t count = read(connection, request + size, sizeof(request) - 1 - size);
        if (count == 0) break;
        if (count < 0) { if (errno == EINTR) continue; return 1; }
        size += (size_t)count;
        if ((preview || websocket) && strstr((char *)request, "\r\n\r\n")) break;
    }
    if (preview || websocket) {
        if (strncmp((char *)request, "GET / HTTP/1.1\r\n", 16) ||
            !strcasestr((char *)request, "host: preview.example\r\n") ||
            strcasestr((char *)request, "authorization:") ||
            strcasestr((char *)request, "cookie:")) return 1;
    } else if (size != sizeof(expected) - 1 || memcmp(request, expected, size)) return 1;
    if (websocket) {
        if (!strstr((char *)request, "dGhlIHNhbXBsZSBub25jZQ==")) return 1;
        const char upgrade[] = "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n";
        if (send(connection, upgrade, sizeof(upgrade)-1, MSG_NOSIGNAL) != (ssize_t)(sizeof(upgrade)-1)) return 1;
        unsigned char frame[12]; size_t received = 0;
        while (received < sizeof(frame)) {
            ssize_t count = read(connection, frame + received, sizeof(frame) - received);
            if (count < 0 && errno == EINTR) continue;
            if (count <= 0) return 1;
            received += (size_t)count;
        }
        if (frame[0] != 0x82 || frame[1] != 0x86) return 1;
        unsigned char reply[8] = {0x82, 6};
        for (int i = 0; i < 6; i++) reply[2+i] = frame[6+i] ^ frame[2+(i%4)];
        if (send(connection, reply, sizeof(reply), MSG_NOSIGNAL) != (ssize_t)sizeof(reply)) return 1;
    } else if (!half && send_response(connection)) return 1;
    close(connection);
    int complete = open("/tmp/jetski-http-complete", O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    if (complete < 0) return 1;
    close(complete);
    /* Keep PID 1 alive until the owned fixture is removed; otherwise the runtime
     * would kill the relay exec while it is draining the response and FIN. */
    for (;;) pause();
}
