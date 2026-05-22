export interface UserContext {
  userId: string;
  role: string;
}

export interface TicketContext {
  authorId: string;
  assigneeId?: string | null;
}

/**
 * Détermine si un utilisateur peut modifier un ticket.
 * - ADMIN : peut tout modifier
 * - AGENT : peut modifier les tickets qui lui sont assignés
 * - USER  : peut modifier uniquement ses propres tickets
 */
export function canEditTicket(user: UserContext, ticket: TicketContext): boolean {
  if (user.role === 'ADMIN') return true;
  if (user.role === 'AGENT') return ticket.assigneeId === user.userId;
  return ticket.authorId === user.userId;
}

/**
 * Détermine si un utilisateur peut supprimer un ticket.
 * Seul l'ADMIN ou l'auteur du ticket peut le supprimer.
 */
export function canDeleteTicket(user: UserContext, ticket: TicketContext): boolean {
  if (user.role === 'ADMIN') return true;
  return ticket.authorId === user.userId;
}

/**
 * Détermine si un utilisateur peut assigner un ticket à quelqu'un.
 * Seuls ADMIN et AGENT peuvent faire des assignations.
 */
export function canAssignTicket(user: UserContext): boolean {
  return user.role === 'ADMIN' || user.role === 'AGENT';
}
