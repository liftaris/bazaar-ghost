-- @better-auth/passkey 1.7.8 schema. A user may sign in with an OAuth account or a passkey;
-- user_credentials is the single definition of "has a sign-in credential".
CREATE TABLE user_passkeys (
  id TEXT PRIMARY KEY NOT NULL, name TEXT, publicKey TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  credentialID TEXT NOT NULL UNIQUE, counter INTEGER NOT NULL, deviceType TEXT NOT NULL,
  backedUp INTEGER NOT NULL CHECK(backedUp IN(0,1)), transports TEXT, createdAt DATE, aaguid TEXT
);
CREATE INDEX user_passkeys_userId_idx ON user_passkeys(userId);
CREATE VIEW user_credentials AS
  SELECT id,userId FROM user_accounts UNION ALL SELECT id,userId FROM user_passkeys;

CREATE TRIGGER auth_passkey_create_guard BEFORE INSERT ON user_passkeys
  WHEN NOT EXISTS(SELECT 1 FROM app_users u WHERE u.id=NEW.userId AND u.status='active'
    AND ((u.registeredAt IS NULL AND NOT EXISTS(SELECT 1 FROM user_credentials c WHERE c.userId=u.id))
      OR EXISTS(SELECT 1 FROM user_sessions s WHERE s.userId=u.id
        AND s.expiresAt>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND s.createdAt>strftime('%Y-%m-%dT%H:%M:%fZ','now','-300 seconds'))))
BEGIN
  SELECT RAISE(ABORT,'Invalid passkey registration');
END;
CREATE TRIGGER auth_passkey_registered AFTER INSERT ON user_passkeys BEGIN
  UPDATE app_users SET registeredAt=COALESCE(registeredAt,CAST(unixepoch('subsec')*1000 AS INTEGER)) WHERE id=NEW.userId;
END;
CREATE TRIGGER auth_passkey_identity_immutable BEFORE UPDATE ON user_passkeys
  WHEN NEW.userId!=OLD.userId OR NEW.credentialID!=OLD.credentialID OR NEW.publicKey!=OLD.publicKey
    OR NOT EXISTS(SELECT 1 FROM app_users WHERE id=NEW.userId AND status='active')
BEGIN
  SELECT RAISE(ABORT,'Invalid passkey update');
END;

DROP TRIGGER auth_account_create_guard;
CREATE TRIGGER auth_account_create_guard BEFORE INSERT ON user_accounts
  WHEN NOT EXISTS(SELECT 1 FROM app_users u WHERE u.id=NEW.userId AND u.status='active'
    AND ((u.registeredAt IS NULL AND NEW.linkSessionId IS NULL AND NOT EXISTS(SELECT 1 FROM user_credentials c WHERE c.userId=u.id))
      OR EXISTS(SELECT 1 FROM user_sessions s WHERE s.id=NEW.linkSessionId AND s.userId=u.id
        AND s.expiresAt>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND s.createdAt>strftime('%Y-%m-%dT%H:%M:%fZ','now','-300 seconds'))))
BEGIN
  SELECT RAISE(ABORT,'Invalid account registration or link session');
END;
DROP TRIGGER auth_session_create_guard;
CREATE TRIGGER auth_session_create_guard BEFORE INSERT ON user_sessions
  WHEN NOT EXISTS(SELECT 1 FROM app_users u WHERE u.id=NEW.userId AND u.status='active'
    AND u.registeredAt IS NOT NULL AND EXISTS(SELECT 1 FROM user_credentials c WHERE c.userId=u.id))
BEGIN
  SELECT RAISE(ABORT,'User cannot sign in');
END;
