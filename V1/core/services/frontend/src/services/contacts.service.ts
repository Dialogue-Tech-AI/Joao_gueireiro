import api from './api';
import type { Conversation } from './attendance.service';

export interface Contact {
  clientPhone: string;
  clientName: string | null;
  lastContactAt: string;
  totalAttendances: number;
}

export interface WhatsAppNumberInfo {
  id: string;
  phoneNumber: string;
  label: string | null;
  connectionStatus: string;
}

class ContactsService {
  async listContacts(): Promise<Contact[]> {
    const response = await api.get('/contacts');
    return response.data.contacts;
  }

  async listWhatsAppNumbers(): Promise<WhatsAppNumberInfo[]> {
    const response = await api.get('/contacts/whatsapp-numbers');
    return response.data.numbers;
  }

  async syncHistory(phoneNumber: string, whatsappNumberId: string): Promise<{ message: string }> {
    const response = await api.post('/contacts/sync-history', { phoneNumber, whatsappNumberId });
    return response.data;
  }

  async importContacts(file: File, whatsappNumberId: string): Promise<{ imported: number; invalid: number; message: string }> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('whatsappNumberId', whatsappNumberId);
    const response = await api.post('/contacts/import', formData);
    return response.data;
  }

  async initiateConversation(
    clientPhone: string,
    whatsappNumberId: string
  ): Promise<{ attendanceId: string; isNew: boolean; conversation: Conversation }> {
    const response = await api.post('/contacts/initiate', { clientPhone, whatsappNumberId });
    return response.data;
  }

  /**
   * Delete all attendances for a contact (by client phone)
   */
  async deleteContact(clientPhone: string): Promise<{ success: boolean; message: string; deletedCount: number }> {
    const response = await api.delete<{ success: boolean; message: string; deletedCount: number }>(
      '/contacts',
      { params: { clientPhone } }
    );
    return response.data;
  }
}

export const contactsService = new ContactsService();
