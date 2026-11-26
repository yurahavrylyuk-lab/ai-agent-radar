import { githubBatchMain } from "./githubBatchRunner.js";

try { process.exitCode = await githubBatchMain(process.env); }
catch {
  console.error("GitHub Batch runner stopped without confirmed completion.");
  process.exitCode = 1;
}
