import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAiSchedulingEventsTable1772300000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ai_scheduling_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        attendance_id uuid NOT NULL REFERENCES attendances(id) ON DELETE CASCADE,
        service_key varchar(32) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS IDX_ai_scheduling_events_service_created
      ON ai_scheduling_events (service_key, created_at);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS IDX_ai_scheduling_events_attendance
      ON ai_scheduling_events (attendance_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS ai_scheduling_events`);
  }
}
