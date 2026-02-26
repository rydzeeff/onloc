export type AuthMode = 'login' | 'verify' | 'recover' | 'verify_otp' | 'verify_otp_recover' | 'recover_complete';

export type Trip = {
  id: string;
  title: string;
  description: string | null;
  date: string | null;
  price: number | null;
  status: string | null;
  creator_id: string | null;
  image_urls: string[] | null;
};

export type Chat = {
  id: string;
  title: string | null;
  chat_type: string;
  trip_id: string | null;
};
