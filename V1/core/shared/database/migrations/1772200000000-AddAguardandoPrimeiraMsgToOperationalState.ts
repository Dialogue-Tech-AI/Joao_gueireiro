import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAguardandoPrimeiraMsgToOperationalState1772200000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const enumTypeResult = await queryRunner.query(`
      SELECT c.udt_name as enum_name
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'attendances'
        AND c.column_name = 'operational_state';
    `);

    const enumTypeName = enumTypeResult?.[0]?.enum_name || 'attendances_operational_state_enum';

    await queryRunner.query(
      `ALTER TYPE "${enumTypeName}" ADD VALUE IF NOT EXISTS 'AGUARDANDO_PRIMEIRA_MSG'`
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL não suporta remover valores de enum de forma segura
    // Manter a migration up-only para este caso
  }
}
