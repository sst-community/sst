/** Anything your own code keeps on a user or a tenant. Only platform admins and your code can change it. */
export type Metadata = Record<string, unknown>;

export interface User {
  /** The user's `sub` in the user pool. */
  id: string;
  /** Lowercase. */
  email?: string;
  name?: string;
  /** The tenant the user's tokens are for. */
  activeTenantId?: string;
  platformAdmin?: boolean;
  metadata?: Metadata;
  createdAt: string;
  updatedAt: string;
}

export interface Tenant {
  id: string;
  name: string;
  /** Created for a user when they signed up. */
  personal?: boolean;
  /** The user who created it. */
  createdBy: string;
  metadata?: Metadata;
  createdAt: string;
  updatedAt: string;
}

export interface Membership {
  tenantId: string;
  userId: string;
  role: string;
  createdAt: string;
  updatedAt: string;
}

/** A member of a tenant, with who they are. */
export interface Member extends Membership {
  email?: string;
  name?: string;
}

/**
 * Someone invited to a tenant by email, who becomes a member when they sign
 * in with that email, verified. There's one for each email in a tenant.
 */
export interface Invitation {
  tenantId: string;
  /** Lowercase. */
  email: string;
  /** The role they'll have. */
  role: string;
  /** The user who invited them, the last time. */
  invitedBy: string;
  /** When it can no longer be taken up. */
  expiresAt: string;
  createdAt: string;
  /** When it was last sent. */
  updatedAt: string;
}

/** A change to a record. A field set to `null` is removed. */
export type Patch<T> = { [K in keyof T]?: T[K] | null };

export type UserPatch = Patch<
  Pick<User, "email" | "name" | "activeTenantId" | "platformAdmin" | "metadata">
>;
export type TenantPatch = Patch<Pick<Tenant, "name" | "metadata">>;

export interface Page<T> {
  items: T[];
  /** Pass it back to get the next page. Not set on the last one. */
  cursor?: string;
}

export interface PageArgs {
  cursor?: string;
  /** At most this many. */
  limit?: number;
}

export interface SearchArgs extends PageArgs {
  /**
   * Only those whose email, for users, or name, for tenants, starts with
   * this, in any case.
   */
  search?: string;
}

/**
 * Where users, tenants and memberships are kept. The built-in handlers only
 * reach storage through this, so another database is another `Store`.
 *
 * Writes that create a record return `false` when it's there already, so
 * that two triggers racing for the same new user both succeed.
 */
export interface Store {
  getUser(id: string): Promise<User | undefined>;
  getUsers(ids: string[]): Promise<User[]>;
  findUserByEmail(email: string): Promise<User | undefined>;
  /**
   * Create a user, and the tenant they own with it when one is given, all
   * or nothing. Returns `false` when the user is there already, and then
   * creates nothing.
   */
  createUser(
    user: User,
    personal?: { tenant: Tenant; membership: Membership },
  ): Promise<boolean>;
  /** Returns the user as changed, or nothing when there's no such user. */
  updateUser(id: string, patch: UserPatch): Promise<User | undefined>;
  /** Users in the order of their email, those with none last. */
  listUsers(page?: SearchArgs): Promise<Page<User>>;

  getTenant(id: string): Promise<Tenant | undefined>;
  getTenants(ids: string[]): Promise<Tenant[]>;
  /** Create a tenant with its first member, all or nothing. */
  createTenant(tenant: Tenant, owner: Membership): Promise<void>;
  updateTenant(id: string, patch: TenantPatch): Promise<Tenant | undefined>;
  /** Delete a tenant, its memberships and its invitations. */
  deleteTenant(id: string): Promise<void>;
  /** Tenants in the order of their name. */
  listTenants(page?: SearchArgs): Promise<Page<Tenant>>;

  getMembership(
    tenantId: string,
    userId: string,
  ): Promise<Membership | undefined>;
  /** Every member of a tenant. */
  listMembers(tenantId: string, page?: PageArgs): Promise<Page<Membership>>;
  /**
   * A tenant's members with a role, read as they are now, not as an index
   * had them: the rule that a tenant keeps an owner reads it.
   */
  membersWithRole(
    tenantId: string,
    role: string,
    page?: PageArgs,
  ): Promise<Page<Membership>>;
  /** Every tenant a user is a member of. */
  listMemberships(userId: string): Promise<Membership[]>;
  /** Add a member, or change their role. */
  putMembership(membership: Membership): Promise<void>;
  deleteMembership(tenantId: string, userId: string): Promise<void>;

  getInvitation(
    tenantId: string,
    email: string,
  ): Promise<Invitation | undefined>;
  /** Every invitation to a tenant, expired ones too until they're removed. */
  listInvitations(tenantId: string): Promise<Invitation[]>;
  /** Every invitation to an email, in any tenant. */
  findInvitations(email: string): Promise<Invitation[]>;
  /** Invite someone, or invite them again: it replaces one to the same email. */
  putInvitation(invitation: Invitation): Promise<void>;
  deleteInvitation(tenantId: string, email: string): Promise<void>;
  /**
   * Turn an invitation into a membership, all or nothing. Returns `false`,
   * and changes nothing, when the invitation is gone or there's a
   * membership already, so that two triggers taking it up at once add the
   * member once.
   */
  acceptInvitation(
    invitation: Invitation,
    membership: Membership,
  ): Promise<boolean>;
}
