import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PLAN_ACCEPTANCE_ROLES, NATIVE_DEPENDENCY_TYPES } from '../plan-graph.types.js';

class PlanNodeDto {
  @IsString()
  @IsNotEmpty()
  nodeId!: string;

  @IsUUID()
  @IsOptional()
  taskId?: string;

  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  acceptedOutputContract?: string | null;
}

class PlanEdgeDto {
  @IsString()
  @IsNotEmpty()
  fromNodeId!: string;

  @IsString()
  @IsNotEmpty()
  toNodeId!: string;

  @IsIn([...PLAN_ACCEPTANCE_ROLES])
  acceptanceRole!: (typeof PLAN_ACCEPTANCE_ROLES)[number];

  @IsIn([...NATIVE_DEPENDENCY_TYPES])
  @IsOptional()
  nativeType?: (typeof NATIVE_DEPENDENCY_TYPES)[number];
}

export class PutPlanRevisionDto {
  @IsInt()
  @Min(0)
  expectedRevision!: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PlanNodeDto)
  nodes!: PlanNodeDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PlanEdgeDto)
  edges!: PlanEdgeDto[];

  @IsString()
  @IsOptional()
  cursor?: string | null;

  @IsObject()
  @IsOptional()
  sourceBindings?: Record<string, string>;

  @IsString()
  @IsOptional()
  leaseHolder?: string | null;
}

export class BindPlanLeaseDto {
  @IsInt()
  @Min(1)
  expectedRevision!: number;

  @IsString()
  @IsNotEmpty()
  expectedPlanDigest!: string;

  @IsString()
  @IsNotEmpty()
  leaseHolder!: string;

  @IsString()
  @IsNotEmpty()
  leaseExpiresAt!: string;
}

export class PlanReadinessDto {
  @IsString()
  @IsNotEmpty()
  nodeId!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PlanNodeRuntimeStateDto)
  states!: PlanNodeRuntimeStateDto[];
}

class PlanNodeRuntimeStateDto {
  @IsString()
  @IsNotEmpty()
  nodeId!: string;

  @IsString()
  @IsOptional()
  status?: string;

  @IsBoolean()
  acceptedOutputSatisfied!: boolean;
}
