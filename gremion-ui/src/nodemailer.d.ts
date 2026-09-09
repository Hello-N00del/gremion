// nodemailer v8 does not ship TypeScript types — project-wide ambient declaration
// to suppress TS7016 until @types/nodemailer is available for v8.
declare module 'nodemailer'
