import { describe, it, expect } from 'vitest';
import { canEditTicket, canDeleteTicket, canAssignTicket } from '@/lib/permissions';

const adminUser   = { userId: 'admin-1', role: 'ADMIN' };
const agentUser   = { userId: 'agent-1', role: 'AGENT' };
const regularUser = { userId: 'user-1',  role: 'USER' };

const ownTicket        = { authorId: 'user-1', assigneeId: null };
const otherTicket      = { authorId: 'user-2', assigneeId: null };
const assignedToAgent  = { authorId: 'user-2', assigneeId: 'agent-1' };
const assignedToOther  = { authorId: 'user-2', assigneeId: 'agent-99' };

describe('canEditTicket', () => {
  it('ADMIN peut modifier n\'importe quel ticket', () => {
    expect(canEditTicket(adminUser, otherTicket)).toBe(true);
    expect(canEditTicket(adminUser, ownTicket)).toBe(true);
  });

  it('AGENT peut modifier un ticket qui lui est assigné', () => {
    expect(canEditTicket(agentUser, assignedToAgent)).toBe(true);
  });

  it('AGENT ne peut pas modifier un ticket assigné à quelqu\'un d\'autre', () => {
    expect(canEditTicket(agentUser, assignedToOther)).toBe(false);
  });

  it('USER peut modifier son propre ticket', () => {
    expect(canEditTicket(regularUser, ownTicket)).toBe(true);
  });

  it('USER ne peut pas modifier le ticket d\'un autre', () => {
    expect(canEditTicket(regularUser, otherTicket)).toBe(false);
  });
});

describe('canDeleteTicket', () => {
  it('ADMIN peut supprimer n\'importe quel ticket', () => {
    expect(canDeleteTicket(adminUser, otherTicket)).toBe(true);
  });

  it('USER peut supprimer son propre ticket', () => {
    expect(canDeleteTicket(regularUser, ownTicket)).toBe(true);
  });

  it('USER ne peut pas supprimer le ticket d\'un autre', () => {
    expect(canDeleteTicket(regularUser, otherTicket)).toBe(false);
  });

  it('AGENT ne peut pas supprimer un ticket dont il n\'est pas l\'auteur', () => {
    expect(canDeleteTicket(agentUser, assignedToAgent)).toBe(false);
  });
});

describe('canAssignTicket', () => {
  it('ADMIN peut assigner des tickets', () => {
    expect(canAssignTicket(adminUser)).toBe(true);
  });

  it('AGENT peut assigner des tickets', () => {
    expect(canAssignTicket(agentUser)).toBe(true);
  });

  it('USER ne peut pas assigner des tickets', () => {
    expect(canAssignTicket(regularUser)).toBe(false);
  });
});
