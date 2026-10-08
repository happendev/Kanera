\set ON_ERROR_STOP on
-- Deterministic isolated data: 10 organisations, 100 boards, 50,000 cards, 300,000 feed events.
INSERT INTO client(id,route_key,name) SELECT md5('client'||n)::uuid,upper(substr(md5('client'||n),1,16)),'Perf org '||n FROM generate_series(1,10) n;
INSERT INTO "user"(id,client_id,email,password_hash,display_name) SELECT md5('user'||n)::uuid,md5('client'||n)::uuid,'perf'||n||'@example.test','none','Perf user '||n FROM generate_series(1,10) n;
INSERT INTO client_member(client_id,user_id,client_role) SELECT md5('client'||n)::uuid,md5('user'||n)::uuid,'owner' FROM generate_series(1,10) n;
INSERT INTO workspace(id,client_id,name,card_key_prefix) SELECT md5('workspace'||n)::uuid,md5('client'||n)::uuid,'Perf workspace '||n,'PERF' FROM generate_series(1,10) n;
INSERT INTO workspace_member(workspace_id,user_id,role) SELECT md5('workspace'||n)::uuid,md5('user'||n)::uuid,'admin' FROM generate_series(1,10) n;
INSERT INTO list(id,workspace_id,name,position) SELECT md5('list'||n)::uuid,md5('workspace'||n)::uuid,'Todo',1 FROM generate_series(1,10) n;
INSERT INTO board(id,workspace_id,name,position) SELECT md5('board'||n)::uuid,md5('workspace'||((n-1)/10+1))::uuid,'Perf board '||n,n FROM generate_series(1,100) n;
INSERT INTO card(id,workspace_id,organisation_key,number,key,list_id,board_id,title,position,created_by_id) SELECT md5('card'||n)::uuid,md5('workspace'||((n-1)/5000+1))::uuid,upper(substr(md5('client'||((n-1)/5000+1)),1,16)),((n-1)%5000)+1,'PERF-'||(((n-1)%5000)+1),md5('list'||((n-1)/5000+1))::uuid,md5('board'||((n-1)/500+1))::uuid,'Perf card '||n,n,md5('user'||((n-1)/5000+1))::uuid FROM generate_series(1,50000) n;
INSERT INTO activity_event(id,board_id,client_id,workspace_id,actor_id,entity_type,entity_id,action,payload,created_at) SELECT md5('event'||n)::uuid,md5('board'||(((n-1)%50000)/500+1))::uuid,md5('client'||(((n-1)%50000)/5000+1))::uuid,md5('workspace'||(((n-1)%50000)/5000+1))::uuid,md5('user'||(((n-1)%50000)/5000+1))::uuid,CASE WHEN n%3=0 THEN 'comment' ELSE 'card' END,CASE WHEN n%3=0 THEN md5('comment'||n)::uuid ELSE md5('card'||(((n-1)%50000)+1))::uuid END,'updated',CASE WHEN n%3=0 THEN jsonb_build_object('cardId',md5('card'||(((n-1)%50000)+1))::uuid) ELSE '{}'::jsonb END,now() - ((300000-n)||' seconds')::interval FROM generate_series(1,300000) n;
ANALYZE;
