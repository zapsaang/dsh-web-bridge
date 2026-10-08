// Only the loader is untyped; all scenarios are compiled by tsconfig.test.json.
const [, , socketJs, scenario, dir] = process.argv;
const runner = new URL('../../test/lifecycle/shutdown-scenarios.js', `file://${socketJs}`);
const { runShutdownScenario } = await import(runner.href);
setTimeout(() => {
  console.error(`FAIL ${scenario}: expected shutdown report/close observation did not arrive`);
  process.exit(1);
}, 5000);
try {
  await runShutdownScenario(scenario, dir);
  console.log(`PASS ${scenario}`);
  process.exit(0); // Quarantine teardown is process exit, never owner recovery.
} catch (error) {
  console.error(error);
  process.exit(1);
}
