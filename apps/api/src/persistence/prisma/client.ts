/**
 * THE PRISMA CLIENT — one instance for the process.
 *
 * Its own module so all three product files share a single connection pool
 * rather than each opening one, and so a test can import the client without
 * dragging in every repository.
 */
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();
