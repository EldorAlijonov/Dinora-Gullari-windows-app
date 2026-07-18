export type DeletedRecordCollection = 'orders' | 'sales';

export class DeletedRecord {
  id?: string;
  _id?: string;
  collection: DeletedRecordCollection;
  recordId: string;
  record: Record<string, unknown>;
  deletedBy?: string;
  deletedAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export type DeletedRecordDocument = DeletedRecord;
