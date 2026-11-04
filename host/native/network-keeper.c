/* Trusted namespace lifetime only: no workload image, I/O, children or commands. */
#include <signal.h>
#include <unistd.h>
static volatile sig_atomic_t done;
static void stop(int value) { (void)value; done = 1; }
int main(void) {
    struct sigaction action = {0};
    action.sa_handler = stop;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGTERM, &action, 0) || sigaction(SIGINT, &action, 0)) return 1;
    while (!done) pause();
    return 0;
}
