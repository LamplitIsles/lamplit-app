// Bind instrumentation and the host to the same declared contracts dependency.
import { mock } from "bun:test";
import * as marked from "../packages/contracts/node_modules/marked";
mock.module("marked", () => marked);
