import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Agent } from './entities/agent.entity';
import { TaskAgent } from './entities/task-agent.entity';
import { CreateAgentDto } from './dto/create-agent.dto';
import { AssignAgentDto } from './dto/assign-agent.dto';
import { AuthService } from '../auth/auth.service';

@Injectable()
export class AgentsService {
  constructor(
    @InjectRepository(Agent)
    private readonly agentRepo: Repository<Agent>,
    @InjectRepository(TaskAgent)
    private readonly taskAgentRepo: Repository<TaskAgent>,
    private readonly authService: AuthService,
  ) {}

  async register(dto: CreateAgentDto): Promise<Agent> {
    const agent = this.agentRepo.create({
      workspaceId: dto.workspaceId,
      name: dto.name,
      model: dto.model ?? null,
      provider: dto.provider ?? null,
      capabilities: dto.capabilities ?? {},
    });
    return this.agentRepo.save(agent);
  }

  async findByWorkspace(workspaceId: string): Promise<Agent[]> {
    return this.agentRepo
      .createQueryBuilder('a')
      .where('a.workspace_id = :workspaceId', { workspaceId })
      .getMany();
  }

  async findOne(agentId: string): Promise<Agent> {
    const agent = await this.agentRepo.findOne({ where: { id: agentId } });
    if (!agent) throw new NotFoundException('Agent not found');
    return agent;
  }

  /** Get tasks assigned to a specific agent */
  async getAgentTasks(agentId: string) {
    return this.taskAgentRepo
      .createQueryBuilder('ta')
      .leftJoinAndSelect('ta.task', 'task')
      .where('ta.agent_id = :agentId', { agentId })
      .getMany();
  }

  async assignToTask(taskId: string, dto: AssignAgentDto): Promise<TaskAgent> {
    const ta = this.taskAgentRepo.create({
      taskId,
      agentId: dto.agentId,
      role: dto.role,
    });
    return this.taskAgentRepo.save(ta);
  }

  async removeFromTask(taskId: string, agentId: string): Promise<void> {
    const ta = await this.taskAgentRepo.findOne({
      where: { taskId, agentId },
    });
    if (!ta) throw new NotFoundException('Agent assignment not found');
    await this.taskAgentRepo.remove(ta);
  }

  // --- API Key lifecycle (delegates to AuthService) ---

  async createApiKey(agentId: string, label?: string) {
    await this.findOne(agentId);
    return this.authService.createApiKey(agentId, label);
  }

  async rotateApiKey(keyId: string) {
    return this.authService.rotateApiKey(keyId);
  }

  async revokeApiKey(keyId: string) {
    return this.authService.revokeApiKey(keyId);
  }
}
