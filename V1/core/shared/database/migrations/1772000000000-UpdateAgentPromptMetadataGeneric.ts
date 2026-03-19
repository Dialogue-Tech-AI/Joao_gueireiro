import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Atualiza metadata do agent_prompt: remove referência legada "Altese", deixa genérico.
 */
export class UpdateAgentPromptMetadataGeneric1772000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE ai_config
      SET metadata = jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{description}',
        '"Prompt base do agente"'
      )
      WHERE key = 'agent_prompt'
        AND (metadata->>'description' = 'Prompt base do agente Altese' OR metadata IS NULL);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE ai_config
      SET metadata = jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{description}',
        '"Prompt base do agente Altese"'
      )
      WHERE key = 'agent_prompt'
        AND metadata->>'description' = 'Prompt base do agente';
    `);
  }
}
