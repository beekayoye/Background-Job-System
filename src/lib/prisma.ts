import { PrismaClient } from '@prisma/client';

/**
 * Global singleton PrismaClient instance.
 * Never instantiate a second PrismaClient in other modules.
 */
export const prisma = new PrismaClient();
