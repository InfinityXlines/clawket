#!/usr/bin/env node
import qrcodeTerminal from 'qrcode-terminal';
import { buildDoctorReport, ensurePairPrerequisites, readRecentCliLogs } from './diagnostics.js';
import { parseLookbackToMs } from './log-parse.js';
import { buildGatewayControlUiOrigin, buildLocalPairingInfo } from './local-pair.js';
import { readCliVersion } from './metadata.js';
import { buildLocalPairingJson, buildPairingJson } from './pairing-output.js';
import { writePairingQrPng, writeRawQrPng } from './qr-file.js';
import { decidePairServiceAction } from './service-decision.js';
import {
  clearServiceState,
  deletePairingConfig,
  getPairingConfigPath,
  getServicePaths,
  getServiceStatus,
  installService,
  isAutostartUnsupportedError,
  listRuntimeProcesses,
  pairGateway,
  getDefaultBridgeDisplayName,
  readPairingConfig,
  registerRuntimeProcess,
  refreshAccessCode,
  restartService,
  startTransientRuntime,
  stopService,
  stopRuntimeProcesses,
  unregisterRuntimeProcess,
  uninstallService,
  type PairingInfo,
  type ServiceStatus,
  writeServiceState,
} from '@clawket/bridge-core';
import {
  BridgeRuntime,
  OpenClawAdapter,
  RpcDispatcher,
  UnifiedAgentRegistry,
  configureOpenClawLanAccess,
  resolveGatewayAuth,
  resolveGatewayUrl,
  restartOpenClawGateway,
} from '@clawket/bridge-runtime';

async function main(): Promise<void> {
  const [, , command = 'help', ...args] = process.argv;
  const isServiceMode = hasFlag(args, '--service');
  const jsonOutput = hasFlag(args, '--json');

  if (command === 'pair') {
    const pairSubcommand = readPairSubcommand(args);
    const localPair = pairSubcommand === 'local' || hasFlag(args, '--local');
    if (localPair) {
      const gatewayAuth = resolveGatewayAuth();
      if ('error' in gatewayAuth) {
        throw new Error(gatewayAuth.error);
      }
      const qrFile = readFlag(args, '--qr-file');
      const explicitLocalUrl = readFlag(args, '--url');
      const local = buildLocalPairingInfo({
        explicitUrl: explicitLocalUrl,
        gatewayToken: gatewayAuth.token,
        gatewayPassword: gatewayAuth.password,
      });
      let message = 'Generated a local gateway pairing QR.';
      let configUpdated = false;
      let controlUiOrigin: string | null = null;
      let gatewayRestartAction: 'restarted' | 'started' | 'unchanged' = 'unchanged';

      if (!explicitLocalUrl) {
        controlUiOrigin = buildGatewayControlUiOrigin(local.gatewayUrl);
        if (!jsonOutput) {
          console.log('⏳ Updating OpenClaw config for LAN access...');
        }
        const lanConfig = await configureOpenClawLanAccess({ controlUiOrigin });
        configUpdated = lanConfig.bindChanged || lanConfig.allowedOriginAdded;
        if (configUpdated) {
          if (!jsonOutput) {
            console.log('⏳ Restarting OpenClaw Gateway...');
          }
          const restart = await restartOpenClawGateway();
          gatewayRestartAction = restart.action;
          if (!jsonOutput) {
            console.log('✅ Gateway is ready.');
          }
        } else if (!jsonOutput) {
          console.log('✅ Gateway already allows LAN pairing.');
        }
        message = configUpdated
          ? 'Configured OpenClaw for LAN access, restarted the Gateway, and generated a local gateway pairing QR.'
          : 'OpenClaw already allowed LAN pairing. Generated a local gateway pairing QR.';
      }

      const qrImagePath = await writeRawQrPng(local.qrPayload, 'clawket-local-pair', qrFile);
      if (jsonOutput) {
        printJson(buildLocalPairingJson({
          gatewayUrl: local.gatewayUrl,
          authMode: local.authMode,
          expiresAt: local.expiresAt,
          qrImagePath,
          message,
          configUpdated,
          controlUiOrigin,
          gatewayRestartAction,
          customUrl: Boolean(explicitLocalUrl),
        }));
      } else {
        printLocalPairingInfo(local.gatewayUrl, local.authMode, local.expiresAt, local.qrPayload, qrImagePath, explicitLocalUrl);
      }
      return;
    }
    const forcePair = hasFlag(args, '--force');
    if (!forcePair) {
      await ensurePairPrerequisites();
    }
    const gatewayAuth = resolveGatewayAuth();
    if ('error' in gatewayAuth) {
      throw new Error(gatewayAuth.error);
    }
    const server = resolvePairServer(args);
    const name = readFlag(args, '--name') ?? readFlag(args, '-n') ?? getDefaultBridgeDisplayName();
    const qrFile = readFlag(args, '--qr-file');
    const paired = await pairGateway({
      serverUrl: server,
      displayName: name,
      gatewayToken: gatewayAuth.token,
      gatewayPassword: gatewayAuth.password,
    });
    const qrImagePath = await writePairingQrPng(paired, qrFile);
    const currentService = getServiceStatus();
    const serviceAction = decidePairServiceAction(paired, currentService);
    if (serviceAction === 'noop') {
      const runtimeProcesses = listRuntimeProcesses();
      if (runtimeProcesses.length > 1) {
        stopRuntimeProcesses();
        const status = restartService();
        const message = 'Detected duplicate bridge runtimes. Restarted the background service cleanly.';
        if (jsonOutput) {
          printJson(buildPairingJson(paired, qrImagePath, status, message));
        } else {
          printPairingInfo(paired, qrImagePath);
          printServiceResult(message, status);
        }
        return;
      }
      if (jsonOutput) {
        printJson(buildPairingJson(paired, qrImagePath, currentService, 'Background service already running. Left unchanged.'));
      } else {
        printPairingInfo(paired, qrImagePath);
        console.log('Background service already running. Left unchanged.');
        printServiceResult(null, currentService);
      }
      return;
    }
    try {
      stopRuntimeProcesses();
      const status = serviceAction === 'install' ? installService() : restartService();
      const message = serviceAction === 'install'
        ? 'Auto-installed background service.'
        : paired.action === 'registered'
          ? 'Bridge identity changed. Restarted background service to load the new pairing.'
          : 'Background service was installed but stopped. Restarted it.';
      if (jsonOutput) {
        printJson(buildPairingJson(paired, qrImagePath, status, message));
      } else {
        printPairingInfo(paired, qrImagePath);
        printServiceResult(message, status);
      }
    } catch (error) {
      if (isAutostartUnsupportedError(error)) {
        const status = await startTransientRuntime();
        const message = buildUnsupportedAutostartMessage(status);
        if (jsonOutput) {
          printJson(buildPairingJson(paired, qrImagePath, status, message));
        } else {
          printPairingInfo(paired, qrImagePath);
          printServiceResult(message, status);
        }
        return;
      }
      console.error(`Pairing succeeded, but service activation failed: ${formatError(error)}`);
      console.error('You can still run "clawket install" or "clawket run" manually.');
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'refresh-code') {
    const qrFile = readFlag(args, '--qr-file');
    const gatewayAuth = resolveGatewayAuth();
    if ('error' in gatewayAuth) {
      throw new Error(gatewayAuth.error);
    }
    const paired = await refreshAccessCode({
      gatewayToken: gatewayAuth.token,
      gatewayPassword: gatewayAuth.password,
    });
    const qrImagePath = await writePairingQrPng(paired, qrFile);
    if (jsonOutput) {
      printJson(buildPairingJson(paired, qrImagePath, getServiceStatus(), 'Pairing code refreshed.'));
    } else {
      printPairingInfo(paired, qrImagePath);
    }
    return;
  }

  if (command === 'install' || command === 'start') {
    const config = requirePairingConfig();
    stopRuntimeProcesses();
    const status = installService();
    console.log(`Installed background service for gateway ${config.gatewayId}.`);
    printServiceResult(null, status);
    return;
  }

  if (command === 'restart') {
    const config = requirePairingConfig();
    stopRuntimeProcesses();
    const status = restartService();
    console.log(`Restarted background service for gateway ${config.gatewayId}.`);
    printServiceResult(null, status);
    return;
  }

  if (command === 'stop') {
    const status = stopService();
    stopRuntimeProcesses();
    console.log('Stopped background service.');
    printServiceResult(null, status);
    return;
  }

  if (command === 'uninstall') {
    const status = uninstallService();
    stopRuntimeProcesses();
    console.log('Removed background service registration.');
    printServiceResult(null, status);
    return;
  }

  if (command === 'reset') {
    stopRuntimeProcesses();
    stopService();
    deletePairingConfig();
    console.log(`Cleared pairing config: ${getPairingConfigPath()}`);
    return;
  }

  if (command === 'status') {
    printStatus();
    return;
  }

  if (command === 'logs') {
    const lines = Number(readFlag(args, '--lines') ?? '200');
    const lastMs = parseLookbackToMs(readFlag(args, '--last') ?? readFlag(args, '-l'));
    const recent = readRecentCliLogs({
      lines,
      lastMs,
      includeErrorLog: hasFlag(args, '--errors'),
    });
    if (jsonOutput) {
      printJson({ ok: true, lines: recent });
    } else if (recent.length === 0) {
      console.log('No matching CLI logs found.');
    } else {
      console.log(recent.join('\n'));
    }
    return;
  }

  if (command === 'doctor') {
    const report = await buildDoctorReport();
    if (jsonOutput) {
      printJson(report);
    } else {
      printDoctorReport(report);
    }
    return;
  }

  if (command === 'run') {
    const config = requirePairingConfig();
    const replaceExisting = hasFlag(args, '--replace');
    const existingRuntimePids = listRuntimeProcesses().map((entry: { pid: number }) => entry.pid);
    if (existingRuntimePids.length > 0) {
      if (!replaceExisting) {
        console.error(
          `Another Clawket bridge runtime is already running (pid${existingRuntimePids.length > 1 ? 's' : ''}: ${existingRuntimePids.join(', ')}). `
          + 'Run "clawket stop" first, or rerun with "--replace" to take over.',
        );
        process.exit(1);
      }
      stopRuntimeProcesses();
    }
    const gatewayUrl = resolveGatewayUrl(readFlag(args, '--gateway-url') ?? readFlag(args, '-g'));
    const emitRuntimeLine = (line: string) => {
      console.log(`[${Date.now()}] ${line}`);
    };
    if (!isServiceMode) {
      console.log(`Gateway ID: ${config.gatewayId}`);
      console.log(`Instance ID: ${config.instanceId}`);
      console.log(`Gateway URL: ${gatewayUrl}`);
      console.log('');
      console.log('Starting bridge runtime. Press Ctrl+C to stop.');
      console.log('');
    } else {
      emitRuntimeLine('Starting Clawket service runtime.');
    }

    if (isServiceMode) {
      writeServiceState();
    }

    const openclawAdapter = new OpenClawAdapter();
    const registry = new UnifiedAgentRegistry([openclawAdapter]);
    const dispatcher = new RpcDispatcher(registry);

    const runtime = new BridgeRuntime({
      config,
      gatewayUrl,
      dispatcher,
      onLog: (line) => {
        emitRuntimeLine(`[clawket] ${line}`);
      },
      onStatus: (snapshot) => {
        if (snapshot.lastError) {
          emitRuntimeLine(
            `[status] relay=${snapshot.relayConnected ? 'up' : 'down'} gateway=${snapshot.gatewayConnected ? 'up' : 'down'} clients=${snapshot.clientCount} error=${snapshot.lastError}`,
          );
          return;
        }
        emitRuntimeLine(
          `[status] relay=${snapshot.relayConnected ? 'up' : 'down'} gateway=${snapshot.gatewayConnected ? 'up' : 'down'} clients=${snapshot.clientCount}`,
        );
      },
      onPendingPairRequest: () => {
        emitRuntimeLine('[pair-request] pending');
      },
    });

    runtime.start();
    registerRuntimeProcess({
      gatewayId: config.gatewayId,
      instanceId: config.instanceId,
      serviceMode: isServiceMode,
    });
    const shutdown = async () => {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      await runtime.stop();
      unregisterRuntimeProcess(process.pid);
      if (isServiceMode) {
        clearServiceState(process.pid);
      }
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await new Promise<void>(() => {});
  }

  printHelp();
}

function printPairingInfo(paired: PairingInfo, qrImagePath: string): void {
  if (paired.action === 'refreshed') {
    console.log('Bridge already paired. Refreshed the pairing code.');
  }
  console.log(`Gateway ID: ${paired.config.gatewayId}`);
  console.log('\nScan this QR code in the Clawket app:\n');
  qrcodeTerminal.generate(paired.qrPayload, { small: true });
  console.log(`Expires: ${formatLocalTime(paired.accessCodeExpiresAt)}`);
  console.log(`QR image: ${qrImagePath}`);
}

function printLocalPairingInfo(
  gatewayUrl: string,
  authMode: 'token' | 'password',
  expiresAt: number,
  qrPayload: string,
  qrImagePath: string,
  customUrl: string | null,
): void {
  console.log(`Gateway URL: ${gatewayUrl}`);
  console.log(`Auth mode: ${authMode}`);
  console.log(customUrl ? '\nScan this custom gateway QR in the Clawket app:\n' : '\nScan this local gateway QR in the Clawket app:\n');
  qrcodeTerminal.generate(qrPayload, { small: true });
  console.log(`Expires: ${new Date(expiresAt).toLocaleString()}`);
  console.log(`QR image: ${qrImagePath}`);
}

function printStatus(): void {
  const config = readPairingConfig();
  const service = getServiceStatus();
  const { logPath, errorLogPath } = getServicePaths();
  const version = readCliVersion();

  console.log(`Version: ${version}`);

  if (!config) {
    console.log(`Config: not paired (${getPairingConfigPath()})`);
  } else {
    console.log(`Config: paired`);
    console.log(`Gateway ID: ${config.gatewayId}`);
    console.log(`Instance: ${config.instanceId}`);
    console.log(`Server URL: ${config.serverUrl}`);
    console.log(`Name: ${config.displayName ?? '-'}`);
  }

  console.log(`Gateway: ${resolveGatewayUrl()}`);
  console.log(`Service: ${service.installed ? 'installed' : 'not installed'} (${service.method})`);
  console.log(`Running: ${service.running ? 'yes' : 'no'}`);
  console.log(`Path: ${service.servicePath || '-'}`);
  console.log(`Log: ${logPath}`);
  console.log(`Error Log: ${errorLogPath}`);

  if (!config) {
    process.exitCode = 1;
  }
}

function printServiceResult(message: string | null, status: ServiceStatus): void {
  if (message) {
    console.log(message);
  }
  console.log(`Service: ${status.installed ? (status.running ? 'installed, running' : 'installed, stopped') : 'not installed'}`);
  console.log(`Service path: ${status.servicePath || '-'}`);
}

function printDoctorReport(report: Awaited<ReturnType<typeof buildDoctorReport>>): void {
  console.log(`Paired: ${report.paired ? 'yes' : 'no'}`);
  console.log(`Gateway ID: ${report.gatewayId ?? '-'}`);
  console.log(`Server URL: ${report.serverUrl ?? '-'}`);
  console.log(`Relay URL: ${report.relayUrl ?? '-'}`);
  console.log(`Instance ID: ${report.instanceId ?? '-'}`);
  console.log(`Service: ${report.serviceInstalled ? 'installed' : 'not installed'} (${report.serviceMethod})`);
  console.log(`Service running: ${report.serviceRunning ? 'yes' : 'no'}`);
  console.log(`Service path: ${report.servicePath || '-'}`);
  console.log(`Log path: ${report.logPath}`);
  console.log(`Error log path: ${report.errorLogPath}`);
  console.log(`OpenClaw dir: ${report.openclawConfigDir}`);
  console.log(`OpenClaw media: ${report.openclawMediaDir}`);
  console.log(`OpenClaw config: ${report.openclawConfigFound ? 'found' : 'missing'}`);
  console.log(`OpenClaw token: ${report.openclawTokenFound ? 'found' : 'missing'}`);
  console.log(`Gateway URL: ${report.localGatewayUrl}`);
  console.log(`Gateway reachable: ${report.localGatewayReachable ? 'yes' : 'no'}`);
}

function requirePairingConfig() {
  const config = readPairingConfig();
  if (!config) {
    console.error(`Not paired. Run "clawket pair" first. Config path: ${getPairingConfigPath()}`);
    process.exit(1);
  }
  return config;
}

function readFlag(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  return value?.trim() ? value.trim() : null;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function resolvePairServer(args: string[]): string {
  const explicit = readFlag(args, '--server') ?? readFlag(args, '-s');
  if (explicit?.trim()) return explicit;

  const envServer = process.env.CLAWKET_REGISTRY_URL?.trim() || process.env.CLAWKET_PACKAGE_DEFAULT_REGISTRY_URL?.trim();
  if (envServer) return envServer;

  throw new Error(
    'No registry server configured. Pass --server https://registry.example.com or set CLAWKET_REGISTRY_URL.',
  );
}

function readPairSubcommand(args: string[]): string | null {
  for (const arg of args) {
    if (!arg.startsWith('-')) {
      return arg.trim() || null;
    }
  }
  return null;
}

function printHelp(): void {
  console.log([
    'clawket pair [--server <url>] [--name <displayName>] [--qr-file <path>] [--json] [--force]',
    'clawket pair local [--url <ws://host:port>] [--qr-file <path>] [--json]',
    'clawket pair --local [--url <ws://host:port>] [--qr-file <path>] [--json]',
    'clawket refresh-code [--qr-file <path>] [--json]',
    'clawket start',
    'clawket install',
    'clawket restart',
    'clawket stop',
    'clawket uninstall',
    'clawket reset',
    'clawket status',
    'clawket logs [--last <2m>] [--lines <200>] [--errors] [--json]',
    'clawket doctor [--json]',
    'clawket run [--gateway-url <ws://127.0.0.1:18789>] [--replace]',
  ].join('\n'));
}

function buildUnsupportedAutostartMessage(status: ServiceStatus): string {
  if (status.running) {
    return 'Started the bridge runtime, but this host does not support automatic startup registration. Use your container or process manager to restart Clawket on reboot.';
  }
  return 'This host does not support automatic startup registration, and the bridge runtime could not be started automatically. Use your container or process manager to run Clawket.';
}

function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

main().catch((error) => {
  console.error(formatError(error));
  process.exit(1);
});
