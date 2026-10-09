import { Global, Logger, Module } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, AppConfig } from '../config/config';
import { ControllerService } from './controller.service';
import { CredentialsService } from './credentials.service';
import { Esp32HardwareAdapter } from './esp32/esp32-hardware.adapter';
import { HARDWARE_ADAPTER, HardwareAdapter } from './hardware-adapter';
import { MockHardwareAdapter } from './mock/mock-hardware.adapter';

@Global()
@Module({
  providers: [
    CredentialsService,
    {
      provide: HARDWARE_ADAPTER,
      inject: [APP_CONFIG, CredentialsService, AuditService],
      useFactory: (config: AppConfig, credentials: CredentialsService, audit: AuditService): HardwareAdapter => {
        const logger = new Logger('HardwareModule');
        // Config validation already requires both flags + mqtts:// for esp32.
        if (config.HARDWARE_MODE === 'esp32' && config.ENABLE_ESP32_ADAPTER) {
          logger.warn('PHYSICAL HARDWARE MODE: commands will drive real pumps');
          return new Esp32HardwareAdapter(
            {
              url: config.MQTT_URL!,
              username: config.MQTT_USERNAME,
              password: config.MQTT_PASSWORD,
              caFile: config.MQTT_CA_FILE,
              heartbeatTimeoutMs: config.HEARTBEAT_TIMEOUT_MS,
            },
            credentials,
            audit,
          );
        }
        logger.log('Mock hardware mode: all controller data is simulated');
        return new MockHardwareAdapter({
          timeScale: config.MOCK_TIME_SCALE,
          tickMs: config.MOCK_TICK_MS,
          fwMaxRuntimeMs: config.MOCK_FW_MAX_RUNTIME_MS,
        });
      },
    },
    ControllerService,
  ],
  exports: [HARDWARE_ADAPTER, ControllerService, CredentialsService],
})
export class HardwareModule {}
