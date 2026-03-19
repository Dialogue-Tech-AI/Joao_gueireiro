import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreateAIConfigTable1737430000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'ai_config',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            default: 'uuid_generate_v4()',
          },
          {
            name: 'key',
            type: 'varchar',
            length: '100',
            isUnique: true,
            isNullable: false,
          },
          {
            name: 'value',
            type: 'text',
            isNullable: false,
          },
          {
            name: 'metadata',
            type: 'jsonb',
            isNullable: true,
          },
          {
            name: 'created_at',
            type: 'timestamp',
            default: 'now()',
            isNullable: false,
          },
          {
            name: 'updated_at',
            type: 'timestamp',
            default: 'now()',
            isNullable: false,
          },
        ],
      }),
      true
    );

    // Create index on key
    await queryRunner.createIndex(
      'ai_config',
      new TableIndex({
        name: 'idx_ai_config_key',
        columnNames: ['key'],
        isUnique: true,
      })
    );

    // Insert default values
    await queryRunner.query(`
      INSERT INTO ai_config (key, value, metadata) VALUES
      ('agent_prompt', '', '{"version": "1.0", "description": "Prompt base do agente"}'),
      ('pending_functions', '{}', '{"version": "1.0", "description": "Configurações das function calls de pendências"}')
      ON CONFLICT (key) DO NOTHING;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('ai_config');
  }
}