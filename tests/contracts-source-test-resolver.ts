// Test-only source binding: no rebuild of the workspace package's dist output.
import { mock } from "bun:test";
import * as contracts from "../packages/contracts/src/index.ts";
import * as client from "../packages/contracts/src/client.ts";
mock.module("@lamplit/contracts", () => contracts);
mock.module("@lamplit/contracts/client", () => client);
