/* MIT licensed. Disposable browser workload; never installed by the runtime. */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <openssl/evp.h>
#include <openssl/sha.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static int send_all(int fd, const void *data, size_t size) {
    const unsigned char *bytes = data;
    while (size) {
        ssize_t n = send(fd, bytes, size, MSG_NOSIGNAL);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return 1;
        bytes += n; size -= (size_t)n;
    }
    return 0;
}
static int read_all(int fd, void *data, size_t size) {
    unsigned char *bytes = data;
    while (size) {
        ssize_t n = read(fd, bytes, size);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return 1;
        bytes += n; size -= (size_t)n;
    }
    return 0;
}
static int serve(int fd) {
    char request[8192] = {0}; size_t size = 0;
    /* Read only the HTTP header so no first WebSocket frame is discarded. */
    while (!strstr(request, "\r\n\r\n")) {
        if (size == sizeof(request)-1 || read_all(fd, request+size, 1)) return 1;
        size++;
    }
    if (strcasestr(request, "\r\nauthorization:") || strcasestr(request, "\r\ncookie:") ||
        strcasestr(request, "\r\norigin:") || strncmp(request, "GET /", 5)) return 1;
    if (strcasestr(request, "\r\nupgrade: websocket\r\n")) {
        const char *key = strcasestr(request, "\r\nsec-websocket-key: ");
        if (!key) return 1;
        key += strlen("\r\nsec-websocket-key: ");
        const char *end = strstr(key, "\r\n");
        if (!end || end-key != 24) return 1;
        char challenge[61]; memcpy(challenge, key, 24);
        memcpy(challenge+24, "258EAFA5-E914-47DA-95CA-C5AB0DC85B11", 37);
        unsigned char hash[SHA_DIGEST_LENGTH], encoded[32];
        SHA1((unsigned char *)challenge, 60, hash);
        EVP_EncodeBlock(encoded, hash, sizeof(hash));
        char response[256];
        int count = snprintf(response, sizeof(response), "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: %s\r\n\r\n", encoded);
        if (count < 0 || (size_t)count >= sizeof(response) || send_all(fd, response, (size_t)count)) return 1;
        for (;;) {
            unsigned char header[2], mask[4], data[125];
            if (read_all(fd, header, 2)) return 0;
            size_t length = header[1] & 127;
            if (!(header[1]&128) || length > 125 || !(header[0]&128) ||
                (header[0] != 0x82 && header[0] != 0x88) || read_all(fd, mask, 4) || read_all(fd, data, length)) return 1;
            for (size_t i=0; i<length; i++) data[i] ^= mask[i%4];
            header[1] = (unsigned char)length;
            if (send_all(fd, header, 2) || send_all(fd, data, length)) return 1;
            if (header[0] == 0x88) return 0;
        }
    }
    const unsigned char binary[] = {0, 255, 128, 1, 2, 3};
    const char html[] = "<!doctype html><title>Container fixture</title><link rel=icon href=data:,><script src=/asset.js></script>relay-container";
    const char script[] = "window.fixtureAsset=true;";
    const void *body = html; size_t length = sizeof(html)-1;
    const char *type = "text/html";
    if (!strncmp(request, "GET /asset.js ", 14)) { body=script; length=sizeof(script)-1; type="text/javascript"; }
    else if (!strncmp(request, "GET /binary ", 12)) { body=binary; length=sizeof(binary); type="application/octet-stream"; }
    else if (strncmp(request, "GET / HTTP/1.1\r\n", 16)) return 1;
    char response[256];
    int count = snprintf(response, sizeof(response), "HTTP/1.1 200 OK\r\nContent-Type: %s\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n", type, length);
    return count < 0 || (size_t)count >= sizeof(response) || send_all(fd, response, (size_t)count) || send_all(fd, body, length);
}
int main(void) {
    signal(SIGCHLD, SIG_IGN);
    int server = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0), reuse = 1;
    struct sockaddr_in address = { .sin_family=AF_INET, .sin_port=htons(18080), .sin_addr={.s_addr=htonl(INADDR_LOOPBACK)} };
    if (server < 0 || setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse)) || bind(server, (struct sockaddr *)&address, sizeof(address)) || listen(server, 16)) return 1;
    int ready = open("/tmp/jetski-http-ready", O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC, 0600);
    if (ready < 0) return 1;
    close(ready);
    for (;;) {
        int fd = accept4(server, NULL, NULL, SOCK_CLOEXEC);
        if (fd < 0) { if (errno == EINTR) continue; return 1; }
        pid_t child = fork();
        if (!child) { close(server); int result=serve(fd); close(fd); _exit(result); }
        close(fd);
        if (child < 0) return 1;
    }
}
