import { MigrationInterface, QueryRunner, Table, TableUnique } from 'typeorm';

export class CreateImportedContactsTable1772100000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'imported_contacts',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            default: 'uuid_generate_v4()',
          },
          {
            name: 'client_phone',
            type: 'varchar',
            length: '20',
            isNullable: false,
          },
          {
            name: 'client_name',
            type: 'varchar',
            length: '200',
            isNullable: true,
          },
          {
            name: 'whatsapp_number_id',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'created_at',
            type: 'timestamp',
            default: 'now()',
            isNullable: false,
          },
        ],
      }),
      true
    );

    await queryRunner.createUniqueConstraint(
      'imported_contacts',
      new TableUnique({
        name: 'UQ_imported_contacts_phone_whatsapp',
        columnNames: ['client_phone', 'whatsapp_number_id'],
      })
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('imported_contacts', true);
  }
}
