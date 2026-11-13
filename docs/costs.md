# Estimate costs

Jetski is MIT software with no software usage fee. You pay your providers for
compute and storage, plus the controller, backups, network and operations.
Check current provider rates and your account's minimums, credits and start fees
before running a workload. A pricing estimate is not a spending guarantee.

## Count the right things

| Measure                               | Why it matters                                                    |
| ------------------------------------- | ----------------------------------------------------------------- |
| Logical sessions                      | Application work; many sequential sessions may reuse one host.    |
| Physical starts                       | Provisioning time and any provider start charges.                 |
| Allocated host-seconds                | Includes bootstrap, restore, work, saves and retained idle.       |
| Retained checkpoint bytes             | History and pins continue consuming storage after compute stops.  |
| Object requests and transferred bytes | Verification and small objects can make request counts important. |
| Controller hosting and backups        | Remote checkpoint objects do not replace controller metadata.     |

For fixed-rate compute, estimate `allocated host-hours × rate + charged starts`.
Then add provider minimums, billing rounding, disk/IP/network, checkpoint storage
and requests. Usage-metered providers may charge CPU, resident memory and written
disk separately. Keep currencies explicit; a credit value is not a wallet debit.
Similar vCPU/RAM labels do not establish equal job throughput.

## Match reuse to your workload

- `runSandbox()` closes its controller and retires eligible owned hosts. Use it
  for one-shot jobs; repeated invocations do not form a persistent warm pool.
- Keep `openJetski()` alive for sequential sessions. `stop()` releases each
  assignment while bounded idle policy can retain its host for the same owner.
- A standalone or embedded platform controller schedules work independently of
  client connections. A Node interval stops when its process stops.

Zero minimum warm capacity is the default. Preparing hosts is a one-shot operation,
not a replenished pool; retained idle hosts still cost compute. Tune idle and lease
bounds to observed return patterns. Adaptive idle quotes guide one decision and
do not enforce an account budget. Inject admission and tenant budgets where needed.

SSH retirement releases adoption; it never stops or deletes the operator's VM.
External provisioning and billing can continue after Jetski releases it. Owner
isolation also prevents pooling unrelated customers onto one host.

## Interpret savings honestly

One measured 104-session-per-policy trace reduced physical starts from six to four
and allocated host time by 7.7%, while warm resume/save latency regressed. It used
unchanged checkpoints and included start credits. Those percentages are not a
forecast for another workload or invoice.
[Method, costs and limits](../maintainer/benchmarks/host-lifecycle.md).

Compare complete work at the same durability boundary. A cheaper hourly rate,
faster command, smaller transfer or fewer starts alone does not establish a lower
end-to-end bill. [Performance settings](performance-tuning.md) explain the knobs.
