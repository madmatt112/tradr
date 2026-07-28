CREATE DATABASE tradr_test;
CREATE DATABASE tradr_test_migrate;

CREATE ROLE tradr_test_user NOINHERIT NOSUPERUSER LOGIN PASSWORD 'tradr_test_user';
GRANT CONNECT ON DATABASE tradr_test_migrate TO tradr_test_user;

\c tradr_test_migrate
GRANT USAGE ON SCHEMA public TO tradr_test_user;
