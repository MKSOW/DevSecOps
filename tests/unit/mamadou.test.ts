import { describe, it, expect } from 'vitest';
import { hashPassword, signToken, verifyToken } from '@/lib/auth';
import { registerSchema, ticketCreateSchema, ticketUpdateSchema } from '@/lib/validators';
import { canEditTicket, canDeleteTicket, canAssignTicket } from '@/lib/permissions';

// =============================================================================
// AUTH — signToken / verifyToken
// =============================================================================

describe('auth.ts — signToken', () => {
  const payload = { userId: 'u42', email: 'mamadou@test.io', role: 'USER' };

  it('retourne un token JWT au format header.payload.signature (3 parties)', () => {
    const token = signToken(payload);
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
  });

  it('le payload du token contient les champs userId, email et role corrects', () => {
    const token = signToken(payload);
    const decoded = verifyToken(token);
    expect(decoded).not.toBeNull();
    expect(decoded!.userId).toBe('u42');
    expect(decoded!.email).toBe('mamadou@test.io');
    expect(decoded!.role).toBe('USER');
  });

  it('retourne null pour une chaîne vide', () => {
    expect(verifyToken('')).toBeNull();
  });

  it('retourne null pour un token tronqué (format invalide)', () => {
    expect(verifyToken('aaa.bbb')).toBeNull();
  });
});

describe('auth.ts — hashPassword', () => {
  it('deux hachages du même mot de passe sont différents (sel aléatoire)', async () => {
    const hash1 = await hashPassword('MonPassword1!');
    const hash2 = await hashPassword('MonPassword1!');
    expect(hash1).not.toBe(hash2);
  });
});

// =============================================================================
// VALIDATORS — registerSchema (valeurs limites)
// =============================================================================

describe('validators.ts — registerSchema (valeurs limites)', () => {
  it('accepte un mot de passe de exactement 8 caractères (minimum)', () => {
    const result = registerSchema.safeParse({
      email: 'a@b.com',
      password: 'Abcdef1!',
      name: 'Mamadou',
    });
    expect(result.success).toBe(true);
  });

  it('rejette un mot de passe de 7 caractères (sous le minimum)', () => {
    const result = registerSchema.safeParse({
      email: 'a@b.com',
      password: 'Abcde1!',
      name: 'Mamadou',
    });
    expect(result.success).toBe(false);
  });

  it('accepte un nom de exactement 2 caractères (minimum)', () => {
    const result = registerSchema.safeParse({
      email: 'a@b.com',
      password: 'Abcdef1!',
      name: 'Ma',
    });
    expect(result.success).toBe(true);
  });

  it('rejette un nom de 1 caractère (sous le minimum)', () => {
    const result = registerSchema.safeParse({
      email: 'a@b.com',
      password: 'Abcdef1!',
      name: 'M',
    });
    expect(result.success).toBe(false);
  });

  it('rejette un mot de passe sans majuscule', () => {
    const result = registerSchema.safeParse({
      email: 'a@b.com',
      password: 'abcdef12',
      name: 'Mamadou',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/majuscule/);
    }
  });

  it('rejette un mot de passe sans chiffre', () => {
    const result = registerSchema.safeParse({
      email: 'a@b.com',
      password: 'AbcdefGH',
      name: 'Mamadou',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/chiffre/);
    }
  });
});

// =============================================================================
// VALIDATORS — ticketCreateSchema (valeurs limites)
// =============================================================================

describe('validators.ts — ticketCreateSchema (valeurs limites)', () => {
  it('accepte un titre de exactement 3 caractères (minimum)', () => {
    const result = ticketCreateSchema.safeParse({
      title: 'Bug',
      description: 'Description suffisamment longue',
    });
    expect(result.success).toBe(true);
  });

  it('rejette un titre de 2 caractères (sous le minimum)', () => {
    const result = ticketCreateSchema.safeParse({
      title: 'Bu',
      description: 'Description suffisamment longue',
    });
    expect(result.success).toBe(false);
  });

  it('rejette une description de 9 caractères (sous le minimum de 10)', () => {
    const result = ticketCreateSchema.safeParse({
      title: 'Mon ticket',
      description: '123456789',
    });
    expect(result.success).toBe(false);
  });

  it('rejette un titre de 141 caractères (au-delà du maximum)', () => {
    const result = ticketCreateSchema.safeParse({
      title: 'A'.repeat(141),
      description: 'Description suffisamment longue',
    });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// VALIDATORS — ticketUpdateSchema (cas non couverts)
// =============================================================================

describe('validators.ts — ticketUpdateSchema (cas supplémentaires)', () => {
  it('accepte assigneeId à null (désassignation)', () => {
    const result = ticketUpdateSchema.safeParse({ assigneeId: null });
    expect(result.success).toBe(true);
  });

  it('rejette une description trop courte lors d\'une mise à jour', () => {
    const result = ticketUpdateSchema.safeParse({ description: 'Court' });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// PERMISSIONS — cas limites non couverts
// =============================================================================

describe('permissions.ts — cas limites', () => {
  const agent = { userId: 'agent-1', role: 'AGENT' };
  const user  = { userId: 'user-1',  role: 'USER' };
  const admin = { userId: 'admin-1', role: 'ADMIN' };

  it('AGENT ne peut pas modifier un ticket sans assignee', () => {
    const ticket = { authorId: 'user-2', assigneeId: null };
    expect(canEditTicket(agent, ticket)).toBe(false);
  });

  it('AGENT peut supprimer un ticket dont il est l\'auteur', () => {
    const ticket = { authorId: 'agent-1', assigneeId: null };
    expect(canDeleteTicket(agent, ticket)).toBe(true);
  });

  it('USER qui est auteur ET assignee peut modifier son ticket', () => {
    const ticket = { authorId: 'user-1', assigneeId: 'user-1' };
    expect(canEditTicket(user, ticket)).toBe(true);
  });

  it('un rôle inconnu ne peut pas assigner de ticket', () => {
    const unknown = { userId: 'x', role: 'SUPERUSER' };
    expect(canAssignTicket(unknown)).toBe(false);
  });

  it('ADMIN peut modifier un ticket non assigné d\'un autre utilisateur', () => {
    const ticket = { authorId: 'user-99', assigneeId: undefined };
    expect(canEditTicket(admin, ticket)).toBe(true);
  });
});
