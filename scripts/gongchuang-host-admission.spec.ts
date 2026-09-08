// Product tests live with the private product contract, while the upstream
// workspace runner intentionally includes only package/app/script globs.
// Import the suite here so the ordinary root Vitest gate cannot skip it.
import '../product/gongchuang-client/tests/host-admission.spec.ts'
