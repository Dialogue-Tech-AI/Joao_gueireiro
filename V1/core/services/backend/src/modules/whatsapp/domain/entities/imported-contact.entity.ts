import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';
import { UUID } from '../../../../shared/types/common.types';

/**
 * Contatos importados em massa (CSV) que ainda não têm atendimento.
 * Só aparecem na aba Contatos. Ao enviar primeira mensagem (Chamar), cria Attendance e sai daqui.
 */
@Entity('imported_contacts')
export class ImportedContact {
  @PrimaryGeneratedColumn('uuid')
  id!: UUID;

  @Column({ name: 'client_phone', type: 'varchar', length: 20 })
  clientPhone!: string;

  @Column({ name: 'client_name', type: 'varchar', length: 200, nullable: true })
  clientName?: string | null;

  @Column({ name: 'whatsapp_number_id', type: 'uuid' })
  whatsappNumberId!: UUID;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
