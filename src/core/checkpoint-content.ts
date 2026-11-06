export const CHECKPOINT_CONTENTS = ["filesystem", "memory"] as const;
export type CheckpointContent = (typeof CHECKPOINT_CONTENTS)[number];
export function checkpointContent(value: unknown): CheckpointContent {
  if (value !== "filesystem" && value !== "memory")
    throw Error("Invalid checkpoint content");
  return value;
}
