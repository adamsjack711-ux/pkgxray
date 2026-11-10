# Experimental local VM

This development feature executes an exact public npm version in a fresh local
QEMU VM. It is not included in the published npm 1.2.1 release and is not enabled
on the hosted MCP or website.

From a stable checkout, after building and testing the VM assets below:

```sh
node bin/audit.js vm-scan npm:picocolors@1.1.1 --yes-run-untrusted-code --format json
```

The command first acquires and statically scans the package. Those acquisition,
registry and advisory requests use the host network; execution inside the guest
has no external network device. `--vm-profile ci` selects synthetic CI credentials
and workspace honeypots instead of the default developer profile. Results are
REVIEW or BLOCK, with exit codes 3 or 2; they never approve installation.

For a local stdio MCP server, the operator must explicitly start it with
`PKGXRAY_VM_TESTS=1` to expose `scan_npm_package_in_vm`. Enabling it authorizes
connected clients to execute these bounded scans. It accepts only an exact npm
reference and a developer/ci profile, with one VM at a time. Leave it disabled
for ordinary static scanning. No caller argument can enable the tool.

## Build and verify

The experimental VM is available in this development checkout. It is not enabled
on the public MCP endpoint or website. Run the host-side regression checks with:

```sh
npm run test:vm:unit
```

To exercise the actual guest, install QEMU with native hardware virtualization
and provide a local Docker engine for building trusted boot assets. Then run:

```sh
npm run build:vm
npm run test:vm
```

The build sends only the five trusted VM source files to the local builder.
Sample code runs in QEMU, with no external network adapter, shared host folders,
or host credentials. The guest has 512 MiB RAM and one CPU; its disks are
read-only and writable workspaces are disposable. Asset digests are checked on
each run, and changing guest sources requires a rebuild.

The suite uses synthetic fixtures for all eleven credential honeypots, aliases,
TCP/UDP/IPv6 denial, isolated DNS, CI and MCP configuration tampering, forged
results, runtime command replacement, detached children, process/memory/file
limits, output/trace floods, and deadlines. It also rejects an unsafe archive
and checks the host watchdog. Each run checks cleanup and prints timings.
For a single fixture, use `npm run test:vm -- udp-egress`.

Failed or interrupted execution requires review. The host rejects contradictory
"not-observed" reports when execution or monitoring is incomplete. A completed
run without findings never approves installation or clears static risk.

Actual guest verification has been performed on macOS ARM64 using HVF. Linux KVM
and Windows WHPX launch arguments have unit coverage, but still need guest runs
on those platforms. These tests do not establish resistance to unknown guest
kernel or QEMU vulnerabilities, and compromised guest kernels can falsify the
guest monitor. Dependencies are not downloaded; delayed, interactive, and
environment-dependent behavior may remain dormant. Keep public execution
disabled while those release requirements are assessed.
