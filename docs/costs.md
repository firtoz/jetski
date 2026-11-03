# Illustrative hosting costs and provider tradeoffs

Rates checked November 3, 2026. These are **models, not cross-provider benchmarks
or quotes**. Jetski is MIT software with no software usage fee. You pay for the
host, retained idle, storage/requests/network, control plane and operations.

## Comparable-sized Linux hosts

| Host                                       | Example shape        |               Compute rate used | Qualification / billing boundary                                                            |
| ------------------------------------------ | -------------------- | ------------------------------: | ------------------------------------------------------------------------------------------- |
| Boat default                               | 4 vCPU / 8 GB        |                     $0.036/hour | Cloud-qualified; $20 monthly minimum including compute credits; start overages can add cost |
| EC2 c6i.xlarge, Linux On-Demand, us-east-1 | 4 vCPU / 8 GiB       |                      $0.17/hour | Illustrative; adopt a prepared host via SSH; no EC2 allocation adapter                      |
| Hetzner CX33, Germany/Finland              | 4 shared vCPU / 8 GB | €0.0136/hour, €8.49 monthly cap | Published new-order rate excluding VAT/IPv4; availability must be checked; adopt via SSH    |

Sources: [Boat pricing](https://boat.dev/),
[AWS's published c6i.xlarge pricing example](https://docs.aws.amazon.com/prescriptive-guidance/latest/optimize-costs-microsoft-workloads/right-size-selection.html),
[Hetzner's June 2026 rate table](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/)
and [host shapes/availability](https://www.hetzner.com/cloud/cost-optimized/).
These are similar capacity labels, not equal CPUs or measured job throughput.
AWS discounts/Spot, other EC2 generations and negotiated rates are outside this model.

## Three monthly usage examples

Assume one owner, sequential work, one host at a time, and **allocated hours
including bootstrap, restore, saves and retained idle**. Hetzner's hourly column
requires external provisioning/deletion; Jetski's SSH adapter never deletes it.

| Usage                                        | Boat compute value (minimum account spend) | EC2 compute | Hetzner compute |
| -------------------------------------------- | -----------------------------------------: | ----------: | --------------: |
| Occasional processing/builds: 100 host-hours |                                $3.60 ($20) |      $17.00 |           €1.36 |
| Weekday interactive workspace: 8 h × 22 days |                                $6.34 ($20) |      $29.92 |           €2.39 |
| One host retained all month: 730 h           |                            $26.28 ($26.28) |     $124.10 |       €8.49 cap |

Boat minimum spending is account-wide, not an extra $20 per host. Compute already
inside an existing plan conserves included credits rather than reducing that
month's payment. Rows assume no paid start surcharges. Multiplying the hourly
rate by job execution time alone understates costs when machines remain idle.

With **today's SSH adoption path**, a Hetzner server kept all month still costs its
monthly cap even if workloads run only 100 hours; the €1.36/€2.39 rows require the
operator to delete/recreate it. The same distinction applies to EC2: Jetski releases
adoption, while external automation must stop/terminate the instance. Disk/IP and
other charges can continue. Owner bindings also prevent using one machine across
unrelated customers. Ten always-retained owner hosts cost approximately ten times
the one-host line; v1 does not assume concurrent container packing.
[Hetzner billing rules](https://docs.hetzner.com/cloud/billing/faq/).

Additional costs: EC2 EBS/public IPv4/egress, checkpoint storage and requests,
control-plane hosting/backups, monitoring and operator time; VAT and currency
conversion are excluded. Object-store retention grows with pinned/acknowledged
history. For scale, R2 Standard's published storage rate is $0.015/GB-month before
free allowances: 100 GB-month is $1.50 of storage value, plus request billing.
This is not a forecast of this workload's retained footprint.
[R2 pricing and billing units](https://developers.cloudflare.com/r2/pricing/).

## What about Boat's build-and-test example?

Boat publishes a Node build/lint/test loop of 1,000 runs in 36 seconds on its
4 vCPU / 8 GB machine, and approximately $0.36 of compute per million runs.
That is **Boat's result**, not a Jetski, EC2 or Hetzner measurement.
[Source and benchmark conditions](https://boat.dev/compare#performance).

A million runs at exactly that throughput takes ten host-hours. Assuming that
same throughput purely for arithmetic gives $0.36 Boat, $1.70 EC2 or €0.136
Hetzner compute value before minimums, rounding, storage and lifecycle overhead.
**We have not established equal throughput.** If a cheaper CPU takes four times
as long, multiply its compute time by four. Reusing a warm host does not make its
compiler faster; it amortizes setup and avoids unnecessary physical starts.
Boat's monthly minimum and Hetzner per-server billing granularity still apply.

## What Jetski actually saved

Our [real lifecycle trace](host-lifecycle-benchmarks.md), on Boat small machines,
reduced starts six to four across 104 sessions per policy and allocated time by
7.7%. Provider compute-value bounds imply $0.00392–$0.00488 saved for that trace;
all starts were included, so no start surcharge was actually saved. At an assumed
uniform $0.03 per physical start, the two avoided starts alone would save $0.06.
That sensitivity is not a prediction of progressive quota charges.

Do not apply 33% fewer starts or 7.7% fewer hours to every usage pattern. A busy
long-running workload, a very sparse workload and many independent owners have
different economics. On an operator-owned always-on host, reducing idle assignments
may improve availability without changing the provider bill.

## Complement, alternative, and limits

On Boat, Jetski is a complementary workspace/durability layer: Boat supplies VMs,
networking and infrastructure; Jetski pools them and manages portable persistent
paths. Jetski can replace custom workspace/checkpoint orchestration and reduce
snapshot dependence for those paths. It cannot replace provider full-disk images,
full VM semantics, desktops or kernel/RAM state.

On your own Linux infrastructure, Jetski offers a useful sandbox API without Boat,
with the operational burden and host security boundary in your control. It does
not provision EC2 or Hetzner automatically today. Neither provider has completed
our hosted conformance/performance matrix. Native allocation adapters could add
that later; the current supported route is explicitly prepared SSH hosts.
