# Restart and reconnect without replay

This example requires the [pending command-handle API](../../docs/compatibility.md).
Use a packed artifact for source review, or the published package after its normal
release. The following commands deliberately separate admission from observation:

```sh
npm install
npm run typecheck
node index.ts start
# The client exits after deliberately aborting observation, without cancellation.
node index.ts observe
```

Use an independently running, authorized Jetski service. Set `JETSKI_URL`,
`JETSKI_TOKEN` and an operator-approved digest-pinned `JETSKI_IMAGE` privately.
Allocation can cost money. Do not run hosted examples without an explicit budget.
`JETSKI_RECOVERY_LOG` optionally chooses the client identity journal; default is
`./reconnect.ndjson` relative to the process working directory. Keep its parent
private. The script synchronizes each identity record before dispatch and refuses
to run `start` twice against one journal. Do not run concurrent writers.

`observe` reconnects to the same service, owner and IDs, reconciles create and
observes the existing command without admission. Only after confirmed completion
does it admit stop. If stop acknowledgement is lost, a subsequent observe waits
for that existing stop ID. It does not repeat the workload or erase history.
Other failures propagate with stable IDs; an absent record after uncertain
admission needs investigation. Do not remove the journal to bypass uncertainty.
Partial/corrupt journals fail closed.

This is a filesystem-backed Linux Node client example. It does not qualify a
hosted runtime or promise universal exactly-once external effects. A command can
remain running after timeout/abort; investigate uncertain outcomes. While the
client is gone the independent service keeps scheduling, retaining/releasing
compute according to its policy. Stopping releases the assignment and may leave
a warm host. Client exit never shuts down that controller.

Embedded mode needs no client journal for generated IDs: reopen the same
`openJetski` directory/configuration, page through `operationIntents()`, then use
`get(sandboxId).command(commandId)` or `waitForOperation(operationId)`. Reopening
can reconcile existing work; it does not authorize replay. A crash-stale lock
requires proof that the old process is gone and the recovery runbook; never steal
it automatically. See [API recovery and errors](../../docs/compatibility.md).
