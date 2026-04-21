declare module 'bcrypt';
declare module 'jsonwebtoken';
declare module 'nodemailer';
declare module 'xml2js';
declare module 'pg';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export {};
