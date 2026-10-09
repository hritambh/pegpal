-- CreateEnum
CREATE TYPE "MachineServiceStatus" AS ENUM ('IN_SERVICE', 'OUT_OF_SERVICE', 'NEEDS_ATTENTION');

-- CreateEnum
CREATE TYPE "HardwareConnection" AS ENUM ('CONNECTED', 'DISCONNECTED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('CREATED', 'AUTHORIZED', 'QUEUED', 'DISPENSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'SAFETY_STOPPED');

-- CreateEnum
CREATE TYPE "OrderItemStatus" AS ENUM ('PENDING', 'DISPENSING', 'COMPLETED', 'FAILED', 'STOPPED', 'SKIPPED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "VerificationLevel" AS ENUM ('MASS_DELTA', 'ESTIMATED', 'SIMULATED', 'UNVERIFIED');

-- CreateEnum
CREATE TYPE "DispenseStrategy" AS ENUM ('TIMED', 'WEIGHT');

-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('TEST_MODE', 'PAYMENT_DISABLED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'TEST_CONFIRMED', 'NOT_REQUIRED');

-- CreateEnum
CREATE TYPE "EventSeverity" AS ENUM ('INFO', 'WARN', 'SAFETY');

-- CreateEnum
CREATE TYPE "CalibrationKind" AS ENUM ('FLOW_RATE', 'VALIDATION');

-- CreateEnum
CREATE TYPE "CalibrationStatus" AS ENUM ('RUNNING', 'AWAITING_MEASUREMENT', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "CommandType" AS ENUM ('DISPENSE', 'STOP', 'TARE', 'STATUS_REQUEST');

-- CreateEnum
CREATE TYPE "CommandOutcome" AS ENUM ('PENDING', 'ACKED', 'REJECTED', 'DONE', 'FAILED', 'STOPPED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "Machine" (
    "id" UUID NOT NULL,
    "publicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "MachineServiceStatus" NOT NULL DEFAULT 'IN_SERVICE',
    "hardwareConnection" "HardwareConnection" NOT NULL DEFAULT 'UNKNOWN',
    "estopActive" BOOLEAN NOT NULL DEFAULT false,
    "faultReason" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "activeOrderId" UUID,
    "activeCalibrationRunId" UUID,
    "commandSeq" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" TIMESTAMP(3),
    "lastStatus" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Machine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Liquid" (
    "id" UUID NOT NULL,
    "machineId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "imageUrl" TEXT,
    "pumpChannel" INTEGER NOT NULL,
    "strategy" "DispenseStrategy" NOT NULL DEFAULT 'TIMED',
    "densityGPerMl" DOUBLE PRECISION,
    "flowRateMlPerSec" DOUBLE PRECISION,
    "cutoffMarginG" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "calibratedAt" TIMESTAMP(3),
    "calibrationSimulated" BOOLEAN NOT NULL DEFAULT false,
    "minMl" INTEGER NOT NULL,
    "maxMl" INTEGER NOT NULL,
    "pricePerMl" DECIMAL(12,4) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "remainingStockMl" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Liquid_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" UUID NOT NULL,
    "machineId" UUID NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'CREATED',
    "totalVolumeMl" INTEGER NOT NULL,
    "totalPrice" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "paymentMode" "PaymentMode" NOT NULL,
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "paymentReference" TEXT,
    "cancelRequestedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "authorizedAt" TIMESTAMP(3),
    "dispensingStartedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "liquidId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "liquidName" TEXT NOT NULL,
    "pumpChannel" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,4) NOT NULL,
    "linePrice" DECIMAL(12,2) NOT NULL,
    "requestedMl" INTEGER NOT NULL,
    "targetMassG" DOUBLE PRECISION,
    "measuredMassG" DOUBLE PRECISION,
    "deliveredMl" DOUBLE PRECISION,
    "verification" "VerificationLevel",
    "verificationNote" TEXT,
    "status" "OrderItemStatus" NOT NULL DEFAULT 'PENDING',
    "runtimeMs" INTEGER,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DispensingEvent" (
    "id" UUID NOT NULL,
    "machineId" UUID,
    "orderId" UUID,
    "calibrationRunId" UUID,
    "type" TEXT NOT NULL,
    "severity" "EventSeverity" NOT NULL DEFAULT 'INFO',
    "pumpChannel" INTEGER,
    "liquidId" UUID,
    "payload" JSONB,
    "actor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DispensingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HardwareCommand" (
    "id" UUID NOT NULL,
    "machineId" UUID NOT NULL,
    "orderId" UUID,
    "orderItemId" UUID,
    "calibrationRunId" UUID,
    "type" "CommandType" NOT NULL,
    "seq" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "outcome" "CommandOutcome" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "ackedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HardwareCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MachineCredential" (
    "id" UUID NOT NULL,
    "machineId" UUID NOT NULL,
    "keyId" TEXT NOT NULL,
    "secretEncrypted" TEXT NOT NULL,
    "lastDeviceSeq" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MachineCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalibrationRun" (
    "id" UUID NOT NULL,
    "machineId" UUID NOT NULL,
    "liquidId" UUID NOT NULL,
    "pumpChannel" INTEGER NOT NULL,
    "kind" "CalibrationKind" NOT NULL,
    "status" "CalibrationStatus" NOT NULL DEFAULT 'RUNNING',
    "commandedRuntimeMs" INTEGER,
    "actualRuntimeMs" INTEGER,
    "targetMl" DOUBLE PRECISION,
    "measuredMl" DOUBLE PRECISION,
    "measuredMassG" DOUBLE PRECISION,
    "computedDensity" DOUBLE PRECISION,
    "computedFlowRate" DOUBLE PRECISION,
    "previousFlowRate" DOUBLE PRECISION,
    "errorPct" DOUBLE PRECISION,
    "simulated" BOOLEAN NOT NULL,
    "simulatedReadingMl" DOUBLE PRECISION,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "operator" TEXT NOT NULL,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CalibrationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Machine_publicId_key" ON "Machine"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "Machine_activeOrderId_key" ON "Machine"("activeOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Machine_activeCalibrationRunId_key" ON "Machine"("activeCalibrationRunId");

-- CreateIndex
CREATE INDEX "Liquid_machineId_idx" ON "Liquid"("machineId");

-- CreateIndex
CREATE UNIQUE INDEX "Liquid_machineId_pumpChannel_key" ON "Liquid"("machineId", "pumpChannel");

-- CreateIndex
CREATE UNIQUE INDEX "Order_idempotencyKey_key" ON "Order"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Order_machineId_createdAt_idx" ON "Order"("machineId", "createdAt");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE UNIQUE INDEX "OrderItem_orderId_position_key" ON "OrderItem"("orderId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "OrderItem_orderId_liquidId_key" ON "OrderItem"("orderId", "liquidId");

-- CreateIndex
CREATE INDEX "DispensingEvent_machineId_createdAt_idx" ON "DispensingEvent"("machineId", "createdAt");

-- CreateIndex
CREATE INDEX "DispensingEvent_orderId_createdAt_idx" ON "DispensingEvent"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "DispensingEvent_severity_createdAt_idx" ON "DispensingEvent"("severity", "createdAt");

-- CreateIndex
CREATE INDEX "HardwareCommand_orderId_idx" ON "HardwareCommand"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "HardwareCommand_machineId_seq_key" ON "HardwareCommand"("machineId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "MachineCredential_keyId_key" ON "MachineCredential"("keyId");

-- CreateIndex
CREATE INDEX "MachineCredential_machineId_idx" ON "MachineCredential"("machineId");

-- CreateIndex
CREATE INDEX "CalibrationRun_liquidId_createdAt_idx" ON "CalibrationRun"("liquidId", "createdAt");

-- AddForeignKey
ALTER TABLE "Liquid" ADD CONSTRAINT "Liquid_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_liquidId_fkey" FOREIGN KEY ("liquidId") REFERENCES "Liquid"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispensingEvent" ADD CONSTRAINT "DispensingEvent_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispensingEvent" ADD CONSTRAINT "DispensingEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HardwareCommand" ADD CONSTRAINT "HardwareCommand_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HardwareCommand" ADD CONSTRAINT "HardwareCommand_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineCredential" ADD CONSTRAINT "MachineCredential_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalibrationRun" ADD CONSTRAINT "CalibrationRun_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalibrationRun" ADD CONSTRAINT "CalibrationRun_liquidId_fkey" FOREIGN KEY ("liquidId") REFERENCES "Liquid"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Second, database-level guarantee that a machine never has two active orders
-- (the primary guard is the conditional reservation on Machine.activeOrderId).
CREATE UNIQUE INDEX "one_active_order_per_machine" ON "Order" ("machineId")
  WHERE "status" IN ('CREATED', 'AUTHORIZED', 'QUEUED', 'DISPENSING');

-- Pump channels are logical indices 0..9.
ALTER TABLE "Liquid" ADD CONSTRAINT "liquid_pump_channel_range" CHECK ("pumpChannel" BETWEEN 0 AND 9);
ALTER TABLE "Liquid" ADD CONSTRAINT "liquid_limits_valid" CHECK ("minMl" > 0 AND "maxMl" >= "minMl");
ALTER TABLE "OrderItem" ADD CONSTRAINT "order_item_volume_positive" CHECK ("requestedMl" > 0);
