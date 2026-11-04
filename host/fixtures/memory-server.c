/* Generic stateful workload: private RAM marker, counter, touched heap and HTTP. */
#include <arpa/inet.h>
#include <errno.h>
#include <inttypes.h>
#include <fcntl.h>
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
    unsigned long mb = argc >= 2 ? strtoul(argv[1], NULL, 10) : 64;
    int high_change = argc >= 3 && strcmp(argv[2], "high") == 0;
    if (argc > 3 || (argc == 3 && !high_change && strcmp(argv[2], "low"))) return 2;
    if (mb < 1 || mb > 256) return 2;
    size_t size = mb * 1024 * 1024;
    unsigned char nonce[16], *heap = malloc(size);
    if (!heap || getrandom(nonce, sizeof(nonce), 0) != (ssize_t)sizeof(nonce)) return 3;
    char token[33];
    for (unsigned i = 0; i < sizeof(nonce); i++) snprintf(token + i * 2, 3, "%02x", nonce[i]);
    uint64_t entropy = UINT64_C(0x6a09e667f3bcc909);
    for (size_t i = 0; i < sizeof(nonce); i++) entropy = (entropy ^ nonce[i]) * UINT64_C(1099511628211);
    if (!entropy) entropy = 1;
    for (size_t i = 0; i < size; i++) {
        if (high_change) { entropy ^= entropy << 13; entropy ^= entropy >> 7; entropy ^= entropy << 17; heap[i] = (unsigned char)entropy; }
        else heap[i] = (unsigned char)(i ^ nonce[i % sizeof(nonce)]);
    }
    signal(SIGPIPE, SIG_IGN);
    int server = socket(AF_INET, SOCK_STREAM, 0), yes = 1;
    if (server < 0 || setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes))) return 4;
    struct sockaddr_in address = {.sin_family=AF_INET, .sin_port=htons(8080)};
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(server, (struct sockaddr *)&address, sizeof(address)) || listen(server, 8)) { perror("memory-server listen"); return 5; }
    int state_file = open("/workspace/process-state.bin", O_RDWR | O_CREAT, 0600);
    if (state_file < 0) return 7;
    unsigned char file_bytes[8192];
    for (size_t i = 0; i < sizeof(file_bytes); i++) file_bytes[i] = (unsigned char)(i * 29 + 7);
    if (pwrite(state_file, file_bytes, sizeof(file_bytes), 0) != (ssize_t)sizeof(file_bytes) ||
        fsync(state_file) || lseek(state_file, 17, SEEK_SET) != 17) return 8;
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
        uint64_t before_checksum = UINT64_C(1469598103934665603);
        for (size_t i = 0; i < size; i++) before_checksum = (before_checksum ^ heap[i]) * UINT64_C(1099511628211);
        counter++;
        if (high_change) {
            for (size_t i = 0; i < size; i++) { entropy ^= entropy << 13; entropy ^= entropy >> 7; entropy ^= entropy << 17; heap[i] = (unsigned char)entropy; }
        } else heap[counter % size] ^= 1;
        uint64_t checksum = UINT64_C(1469598103934665603);
        for (size_t i = 0; i < size; i++) checksum = (checksum ^ heap[i]) * UINT64_C(1099511628211);
        off_t file_before = lseek(state_file, 0, SEEK_CUR);
        unsigned char next_bytes[32];
        if (file_before < 0 || read(state_file, next_bytes, sizeof(next_bytes)) != (ssize_t)sizeof(next_bytes)) return 9;
        uint64_t file_checksum = UINT64_C(1469598103934665603);
        for (size_t i = 0; i < sizeof(next_bytes); i++) file_checksum = (file_checksum ^ next_bytes[i]) * UINT64_C(1099511628211);
        off_t file_after = lseek(state_file, 0, SEEK_CUR);
        char body[512], header[256];
        int bytes = snprintf(body, sizeof(body), "{\"token\":\"%s\",\"counter\":%" PRIu64 ",\"heapBytes\":%zu,\"beforeChecksum\":\"%016" PRIx64 "\",\"checksum\":\"%016" PRIx64 "\",\"fileOffsetBefore\":%jd,\"fileOffsetAfter\":%jd,\"fileChecksum\":\"%016" PRIx64 "\"}\n", token, counter, size, before_checksum, checksum, (intmax_t)file_before, (intmax_t)file_after, file_checksum);
        int headers = snprintf(header, sizeof(header), "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n", bytes);
        if (bytes < 0 || (size_t)bytes >= sizeof(body) || headers < 0 || (size_t)headers >= sizeof(header)) return 7;
        if (send_all(fd, header, (size_t)headers) == 0) (void)send_all(fd, body, (size_t)bytes);
        close(fd);
    }
}
