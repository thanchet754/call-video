-- SQL Schema cho hệ thống Nhắn tin & Gọi điện (Supabase)

-- 1. BẢNG PROFILES (Thông tin người dùng)
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  updated_at timestamp with time zone default now(),
  username text unique not null,
  full_name text,
  avatar_url text,
  status text default 'offline', -- 'online', 'offline', 'away'
  is_approved boolean default false not null, -- Chờ admin duyệt
  is_admin boolean default false not null -- Quyền admin
);

-- Kích hoạt RLS cho profiles
alter table public.profiles enable row level security;

-- 2. BẢNG ROOMS (Phòng chat)
create table public.rooms (
  id uuid default gen_random_uuid() primary key,
  created_at timestamp with time zone default now() not null,
  name text, -- Dùng cho chat nhóm
  is_group boolean default false not null
);

-- Kích hoạt RLS cho rooms
alter table public.rooms enable row level security;

-- 3. BẢNG ROOM_MEMBERS (Thành viên phòng chat)
create table public.room_members (
  room_id uuid references public.rooms(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  joined_at timestamp with time zone default now() not null,
  primary key (room_id, user_id)
);

-- Kích hoạt RLS cho room_members
alter table public.room_members enable row level security;

-- 4. BẢNG MESSAGES (Tin nhắn)
create table public.messages (
  id uuid default gen_random_uuid() primary key,
  room_id uuid references public.rooms(id) on delete cascade not null,
  sender_id uuid references public.profiles(id) on delete cascade not null,
  content text,
  file_url text, -- File đính kèm / hình ảnh
  created_at timestamp with time zone default now() not null,
  parent_id uuid references public.messages(id) on delete set null, -- Trích dẫn/Trả lời tin nhắn khác
  is_pinned boolean default false not null -- Cờ ghim tin nhắn
);

-- Kích hoạt RLS cho messages
alter table public.messages enable row level security;

-- 5. BẢNG MESSAGE_REACTIONS (Cảm xúc tin nhắn)
create table public.message_reactions (
  message_id uuid references public.messages(id) on delete cascade not null,
  user_id uuid references public.profiles(id) on delete cascade not null,
  emoji text not null,
  created_at timestamp with time zone default now() not null,
  primary key (message_id, user_id, emoji)
);

-- Kích hoạt RLS cho message_reactions
alter table public.message_reactions enable row level security;


------------------------------------------------------------------------------------
-- TRIGGER TỰ ĐỘNG TẠO PROFILE KHI ĐĂNG KÝ
------------------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger as $$
declare
  default_username text;
  default_full_name text;
begin
  default_username := coalesce(
    new.raw_user_meta_data->>'username', 
    split_part(new.email, '@', 1) || '_' || substr(new.id::text, 1, 4)
  );
  default_full_name := coalesce(
    new.raw_user_meta_data->>'full_name', 
    split_part(new.email, '@', 1)
  );

  insert into public.profiles (id, username, full_name, avatar_url, is_approved, is_admin)
  values (
    new.id,
    default_username,
    default_full_name,
    new.raw_user_meta_data->>'avatar_url',
    false, -- Mặc định chưa duyệt
    false  -- Mặc định không phải admin
  );
  return new;
end;
$$ language plpgsql security definer;

-- Tạo trigger
create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();


------------------------------------------------------------------------------------
-- CHÍNH SÁCH BẢO MẬT ROW LEVEL SECURITY (RLS)
------------------------------------------------------------------------------------

-- Hàm tiện ích kiểm tra xem người dùng hiện tại có được duyệt hay chưa
create or replace function public.is_approved_user()
returns boolean as $$
begin
  return exists (
    select 1 from public.profiles 
    where id = auth.uid() and is_approved = true
  );
end;
$$ language plpgsql security definer;

-- Hàm tiện ích kiểm tra xem người dùng hiện tại có phải admin không
create or replace function public.is_admin_user()
returns boolean as $$
begin
  return exists (
    select 1 from public.profiles 
    where id = auth.uid() and is_admin = true
  );
end;
$$ language plpgsql security definer;


-- ** RLS Policies cho PROFILES **

create policy "Cho phép người dùng chưa duyệt xem profile của mình"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Cho phép người dùng đã duyệt xem danh sách profile"
  on public.profiles for select
  using (public.is_approved_user());

create policy "Cho phép người dùng cập nhật profile của mình"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

create policy "Cho phép Admin quản lý toàn bộ profile"
  on public.profiles for all
  using (public.is_admin_user());


-- ** RLS Policies cho ROOMS **

create policy "Thành viên đã duyệt có quyền xem phòng chat"
  on public.rooms for select
  using (
    public.is_approved_user() and 
    exists (
      select 1 from public.room_members 
      where room_id = id and user_id = auth.uid()
    )
  );

create policy "Thành viên đã duyệt có quyền tạo phòng chat"
  on public.rooms for insert
  with check (public.is_approved_user());

create policy "Admin được phép chỉnh sửa phòng chat"
  on public.rooms for all
  using (public.is_admin_user());


-- ** RLS Policies cho ROOM_MEMBERS **

create policy "Thành viên đã duyệt có quyền xem danh sách thành viên phòng"
  on public.room_members for select
  using (
    public.is_approved_user() and 
    exists (
      select 1 from public.room_members rm
      where rm.room_id = room_id and rm.user_id = auth.uid()
    )
  );

create policy "Thành viên đã duyệt có quyền thêm người vào phòng"
  on public.room_members for insert
  with check (public.is_approved_user());

create policy "Thành viên đã duyệt có quyền rời phòng"
  on public.room_members for delete
  using (public.is_approved_user() and user_id = auth.uid());

create policy "Admin được phép quản lý toàn bộ thành viên phòng"
  on public.room_members for all
  using (public.is_admin_user());


-- ** RLS Policies cho MESSAGES **

create policy "Thành viên trong phòng đã duyệt có quyền xem tin nhắn"
  on public.messages for select
  using (
    public.is_approved_user() and 
    exists (
      select 1 from public.room_members 
      where room_id = messages.room_id and user_id = auth.uid()
    )
  );

create policy "Thành viên trong phòng đã duyệt có quyền gửi tin nhắn"
  on public.messages for insert
  with check (
    public.is_approved_user() and 
    sender_id = auth.uid() and
    exists (
      select 1 from public.room_members 
      where room_id = messages.room_id and user_id = auth.uid()
    )
  );

create policy "Người gửi có quyền sửa hoặc thu hồi tin nhắn của mình"
  on public.messages for update
  using (
    public.is_approved_user() and 
    sender_id = auth.uid()
  )
  with check (
    public.is_approved_user() and 
    sender_id = auth.uid()
  );

create policy "Admin được phép quản lý toàn bộ tin nhắn"
  on public.messages for all
  using (public.is_admin_user());


-- ** RLS Policies cho MESSAGE_REACTIONS **

create policy "Thành viên trong phòng đã duyệt có quyền xem cảm xúc"
  on public.message_reactions for select
  using (
    public.is_approved_user() and 
    exists (
      select 1 from public.messages m
      join public.room_members rm on rm.room_id = m.room_id
      where m.id = message_id and rm.user_id = auth.uid()
    )
  );

create policy "Thành viên trong phòng đã duyệt có quyền thả cảm xúc"
  on public.message_reactions for insert
  with check (
    public.is_approved_user() and 
    user_id = auth.uid() and
    exists (
      select 1 from public.messages m
      join public.room_members rm on rm.room_id = m.room_id
      where m.id = message_id and rm.user_id = auth.uid()
    )
  );

create policy "Người thả cảm xúc có quyền xóa cảm xúc của mình"
  on public.message_reactions for delete
  using (
    public.is_approved_user() and 
    user_id = auth.uid()
  );


------------------------------------------------------------------------------------
-- CÁCH THIẾT LẬP TÀI KHOẢN ADMIN ĐẦU TIÊN (Sau khi bạn đăng ký tài khoản trên web)
------------------------------------------------------------------------------------
-- Bạn cần vào Supabase SQL Editor và chạy dòng lệnh sau (thay thế email của bạn):
-- UPDATE public.profiles 
-- SET is_approved = true, is_admin = true 
-- WHERE id = (
--   SELECT id FROM auth.users WHERE email = 'email-cua-ban@gmail.com' LIMIT 1
-- );
