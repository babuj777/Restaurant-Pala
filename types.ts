export interface MenuItem {
  name: string;
  price: number;
  description?: string;
  category: 'Special' | 'Drink' | 'Main';
}

export interface OrderItem {
  name: string;
  quantity: number;
}

export interface BookingDetails {
  date: string;
  time: string;
  people: number;
  specialRequests?: string;
}

export interface OrderDetails {
  items: string[];
  address: string;
  landmark: string;
  phone?: string;
}

export enum ConnectionStatus {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  ERROR = 'error',
}

export interface LogEntry {
  timestamp: Date;
  sender: 'user' | 'babu' | 'system';
  message: string;
  type?: 'info' | 'success' | 'warning';
}