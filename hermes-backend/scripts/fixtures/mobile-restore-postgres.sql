-- Synthetic data only, applied exclusively to a newly created disposable database.
INSERT INTO users (id,email,password,name,"updatedAt")
VALUES ('synthetic-user','synthetic@example.invalid','not-a-real-hash','Fixture',now());
INSERT INTO mobile_sessions (id,"userId","refreshHash","expiresAt","updatedAt")
VALUES ('synthetic-session','synthetic-user','not-a-real-hash',now()+interval '1 day',now());
INSERT INTO consumed_crm_proofs (jti,"expiresAt")
VALUES ('synthetic-jti',now()+interval '1 day');
INSERT INTO mobile_reply_operations ("operationId","conversationId","userId","contentHash","updatedAt")
VALUES ('00000000-0000-4000-8000-000000000001','synthetic-conversation','synthetic-user',repeat('a',64),now());
