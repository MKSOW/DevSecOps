import { describe, it, expect } from 'vitest';
import { signToken, verifyToken } from '@/lib/auth';
import { loginSchema, ticketUpdateSchema } from '@/lib/validators';

// ─── Tests JWT supplémentaires ───────────────────────────────────────────────

describe('auth.ts — token expiré', () => {
  it('retourne null pour un token avec exp dans le passé', () => {
    // On forge un token manuellement avec une date d'expiration passée
    // jwt.sign accepte un payload avec exp (timestamp Unix en secondes)
    const jwt = require('jsonwebtoken');
    const secret = process.env.JWT_SECRET || 'fallback-secret-change-me';
    const expiredToken = jwt.sign(
      { userId: 'u1', email: 'x@x.com', role: 'USER', exp: Math.floor(Date.now() / 1000) - 3600 },
      secret
    );
    expect(verifyToken(expiredToken)).toBeNull();
  });

  it('un token signé sans secret différent est rejeté', () => {
    const jwt = require('jsonwebtoken');
    const foreignToken = jwt.sign(
      { userId: 'u1', email: 'x@x.com', role: 'ADMIN' },
      'un-autre-secret-completement-different'
    );
    expect(verifyToken(foreignToken)).toBeNull();
  });
});

// ─── loginSchema ─────────────────────────────────────────────────────────────

describe('validators.ts — loginSchema', () => {
  it('accepte un email + mot de passe valides', () => {
    const result = loginSchema.safeParse({ email: 'admin@helpdesk.io', password: 'Password123!' });
    expect(result.success).toBe(true);
  });

  it('rejette si le mot de passe est vide', () => {
    const result = loginSchema.safeParse({ email: 'admin@helpdesk.io', password: '' });
    expect(result.success).toBe(false);
  });

  it('rejette si l\'email est mal formé', () => {
    const result = loginSchema.safeParse({ email: 'pas-un-email', password: 'abc' });
    expect(result.success).toBe(false);
  });
});

// ─── ticketUpdateSchema ───────────────────────────────────────────────────────

describe('validators.ts — ticketUpdateSchema', () => {
  it('accepte une mise à jour de statut seul', () => {
    const result = ticketUpdateSchema.safeParse({ status: 'RESOLVED' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.status).toBe('RESOLVED');
  });

  it('rejette un statut invalide', () => {
    const result = ticketUpdateSchema.safeParse({ status: 'PENDING' });
    expect(result.success).toBe(false);
  });

  it('accepte une mise à jour de priorité seule', () => {
    const result = ticketUpdateSchema.safeParse({ priority: 'URGENT' });
    expect(result.success).toBe(true);
  });

  it('rejette un titre trop court', () => {
    const result = ticketUpdateSchema.safeParse({ title: 'ab' });
    expect(result.success).toBe(false);
  });

  it('accepte un objet vide (aucun champ obligatoire)', () => {
    const result = ticketUpdateSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});
