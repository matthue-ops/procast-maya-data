CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE TABLE public.app_state(id text PRIMARY KEY,payload jsonb,updated_at timestamptz DEFAULT timezone('utc',now()));
GRANT ALL ON public.app_state TO anon,authenticated,service_role;
INSERT INTO public.app_state(id,payload) VALUES('main_data','{"customFields":[],"establishments":[],"savedFilters":[],"aftersalesHeaders":[],"aftersalesRecords":[]}');
