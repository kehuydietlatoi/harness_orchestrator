import pc from "picocolors";
import { buildSnapshot } from "../board/snapshot.js";
import { formatSnapshotTable } from "./snapshot.js";

export async function boardCommand(): Promise<void> {
  console.log(pc.bold("orch board\n"));
  console.log(formatSnapshotTable(await buildSnapshot(process.cwd())));
}
