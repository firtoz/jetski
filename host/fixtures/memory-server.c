/* Generic stateful workload: private RAM marker, counter, touched heap and HTTP. */
#include <arpa/inet.h>
#include <errno.h>
#include <inttypes.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/random.h>
#include <sys/socket.h>
#include <unistd.h>

static int send_all(int fd, const char *data, size_t bytes) {
    while (bytes) {
        ssize_t n = send(fd, data, bytes, MSG_NOSIGNAL);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return -1;
        data += n; bytes -= (size_t)n;
    }
    return 0;
}
int main(int argc, char **argv) {
    unsigned long mb = argc == 2 ? strtoul(argv[1], NULL, 10) : 64;
    if (mb < 1 || mb > 256) return 2;
    size_t size = mb * 1024 * 1024;
    unsigned char nonce[16], *heap = malloc(size);
    if (!heap || getrandom(nonce, sizeof(nonce), 0) != (ssize_t)sizeof(nonce)) return 3;
    char token[33];
    for (unsigned i = 0; i < sizeof(nonce); i++) snprintf(token + i * 2, 3, "%02x", nonce[i]);
    for (size_t i = 0; i < size; i++) heap[i] = (unsigned char)(i ^ nonce[i % sizeof(nonce)]);
    signal(SIGPIPE, SIG_IGN);
    int server = socket(AF_INET, SOCK_STREAM, 0), yes = 1;
    if (server < 0 || setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes))) return 4;
    struct sockaddr_in address = {.sin_family=AF_INET, .sin_port=htons(8080)};
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(server, (struct sockaddr *)&address, sizeof(address)) || listen(server, 8)) return 5;
    uint64_t counter = 0;
    for (;;) {
        int fd = accept(server, NULL, NULL);
        if (fd < 0) { if (errno == EINTR) continue; return 6; }
        char request[16385]; size_t have = 0;
        while (have < sizeof(request) - 1) {
            ssize_t n = recv(fd, request + have, sizeof(request) - 1 - have, 0);
            if (n < 0 && errno == EINTR) continue;
            if (n <= 0) break;
            have += (size_t)n; request[have] = 0;
            if (strstr(request, "\r\n\r\n")) break;
        }
        if (!have) { close(fd); continue; }
        counter++;
        heap[counter % size] ^= 1;
        uint64_t checksum = UINT64_C(1469598103934665603);
        for (size_t i = 0; i < size; i++) checksum = (checksum ^ heap[i]) * UINT64_C(1099511628211);
        char body[256], header[256];
        int bytes = snprintf(body, sizeof(body), "{\"token\":\"%s\",\"counter\":%" PRIu64 ",\"heapBytes\":%zu,\"checksum\":\"%016" PRIx64 "\"}\n", token, counter, size, checksum);
        int headers = snprintf(header, sizeof(header), "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n", bytes);
        if (bytes < 0 || (size_t)bytes >= sizeof(body) || headers < 0 || (size_t)headers >= sizeof(header)) return 7;
        if (send_all(fd, header, (size_t)headers) == 0) (void)send_all(fd, body, (size_t)bytes);
        close(fd);
    }
}
