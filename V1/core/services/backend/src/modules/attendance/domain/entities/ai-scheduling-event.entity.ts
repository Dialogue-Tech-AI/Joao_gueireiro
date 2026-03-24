import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { UUID } from '../../../../shared/types/common.types';

/** Registro de cada acionamento das FCs agendamento_flash_day / locacao / captacao (estatísticas). */
@Entity('ai_scheduling_events')
@Index('IDX_ai_scheduling_events_service_created', ['serviceKey', 'createdAt'])
export class AiSchedulingEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: UUID;

  @Column({ name: 'attendance_id', type: 'uuid' })
  attendanceId!: UUID;

  /** flash-day | locacao-estudio | captacao-videos */
  @Column({ name: 'service_key', type: 'varchar', length: 32 })
  serviceKey!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
