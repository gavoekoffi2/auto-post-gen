export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "13.0.5"
  }
  public: {
    Tables: {
      posts: {
        Row: {
          auto_publish_attempted_at: string | null
          content: string
          created_at: string | null
          id: string
          image_url: string | null
          platforms: string[]
          publish_error: string | null
          published_at: string | null
          scheduled_for: string | null
          status: string
          title: string
          updated_at: string | null
          user_id: string
          validation_status: string | null
          validation_token: string | null
          validation_token_created_at: string | null
          validation_token_used_at: string | null
          week_number: number | null
          provider_post_id: string | null
          external_post_ids: Json
        }
        Insert: {
          auto_publish_attempted_at?: string | null
          content: string
          created_at?: string | null
          id?: string
          image_url?: string | null
          platforms?: string[]
          publish_error?: string | null
          published_at?: string | null
          scheduled_for?: string | null
          status?: string
          title: string
          updated_at?: string | null
          user_id: string
          validation_status?: string | null
          validation_token?: string | null
          validation_token_created_at?: string | null
          validation_token_used_at?: string | null
          week_number?: number | null
          provider_post_id?: string | null
          external_post_ids?: Json
        }
        Update: {
          auto_publish_attempted_at?: string | null
          content?: string
          created_at?: string | null
          id?: string
          image_url?: string | null
          platforms?: string[]
          publish_error?: string | null
          published_at?: string | null
          scheduled_for?: string | null
          status?: string
          title?: string
          updated_at?: string | null
          user_id?: string
          validation_status?: string | null
          validation_token?: string | null
          validation_token_created_at?: string | null
          validation_token_used_at?: string | null
          week_number?: number | null
          provider_post_id?: string | null
          external_post_ids?: Json
        }
        Relationships: []
      }
      social_connections: {
        Row: {
          access_token: string
          account_id: string
          account_name: string | null
          account_username: string | null
          created_at: string | null
          id: string
          meta: Json | null
          platform: string
          profile_key: string | null
          provider: string | null
          refresh_token: string | null
          scopes: string[] | null
          token_expires_at: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          access_token: string
          account_id: string
          account_name?: string | null
          account_username?: string | null
          created_at?: string | null
          id?: string
          meta?: Json | null
          platform: string
          profile_key?: string | null
          provider?: string | null
          refresh_token?: string | null
          scopes?: string[] | null
          token_expires_at?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          access_token?: string
          account_id?: string
          account_name?: string | null
          account_username?: string | null
          created_at?: string | null
          id?: string
          meta?: Json | null
          platform?: string
          profile_key?: string | null
          provider?: string | null
          refresh_token?: string | null
          scopes?: string[] | null
          token_expires_at?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      generation_usage: {
        Row: {
          created_at: string | null
          error: string | null
          function_name: string
          id: string
          status: string
          user_id: string
        }
        Insert: {
          created_at?: string | null
          error?: string | null
          function_name: string
          id?: string
          status?: string
          user_id: string
        }
        Update: {
          created_at?: string | null
          error?: string | null
          function_name?: string
          id?: string
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      social_comments: {
        Row: {
          author_avatar_url: string | null
          author_handle: string | null
          author_name: string | null
          comment_created_at: string | null
          created_at: string | null
          external_comment_id: string
          id: string
          message: string | null
          parent_comment_id: string | null
          platform: string
          post_id: string | null
          provider: string
          raw: Json
          replied_at: string | null
          replied_by: string | null
          reply_external_id: string | null
          reply_text: string | null
          status: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          author_avatar_url?: string | null
          author_handle?: string | null
          author_name?: string | null
          comment_created_at?: string | null
          created_at?: string | null
          external_comment_id: string
          id?: string
          message?: string | null
          parent_comment_id?: string | null
          platform: string
          post_id?: string | null
          provider?: string
          raw?: Json
          replied_at?: string | null
          replied_by?: string | null
          reply_external_id?: string | null
          reply_text?: string | null
          status?: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          author_avatar_url?: string | null
          author_handle?: string | null
          author_name?: string | null
          comment_created_at?: string | null
          created_at?: string | null
          external_comment_id?: string
          id?: string
          message?: string | null
          parent_comment_id?: string | null
          platform?: string
          post_id?: string | null
          provider?: string
          raw?: Json
          replied_at?: string | null
          replied_by?: string | null
          reply_external_id?: string | null
          reply_text?: string | null
          status?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          activity_keywords: string[] | null
          auto_publish: boolean | null
          brand_accent_color: string | null
          brand_font: string | null
          brand_primary_color: string | null
          brand_secondary_color: string | null
          company_name: string | null
          connected_platforms: string[] | null
          content_types: string[]
          created_at: string | null
          custom_image_urls: string[] | null
          description: string | null
          email: string | null
          facebook_username: string | null
          id: string
          image_people_type: string | null
          image_style: string | null
          instagram_username: string | null
          linkedin_username: string | null
          logo_url: string | null
          platforms: string[]
          post_frequency: number
          preferred_days: string[] | null
          sector: string
          style_example: string | null
          style_examples: Json | null
          tiktok_username: string | null
          tone: string
          twitter_username: string | null
          updated_at: string | null
          use_custom_images: boolean | null
          auto_reply_enabled: boolean | null
          auto_reply_instructions: string | null
        }
        Insert: {
          activity_keywords?: string[] | null
          auto_publish?: boolean | null
          brand_accent_color?: string | null
          brand_font?: string | null
          brand_primary_color?: string | null
          brand_secondary_color?: string | null
          company_name?: string | null
          connected_platforms?: string[] | null
          content_types: string[]
          created_at?: string | null
          custom_image_urls?: string[] | null
          description?: string | null
          email?: string | null
          facebook_username?: string | null
          id: string
          image_people_type?: string | null
          image_style?: string | null
          instagram_username?: string | null
          linkedin_username?: string | null
          logo_url?: string | null
          platforms?: string[]
          post_frequency?: number
          preferred_days?: string[] | null
          sector: string
          style_example?: string | null
          style_examples?: Json | null
          tiktok_username?: string | null
          tone: string
          twitter_username?: string | null
          updated_at?: string | null
          use_custom_images?: boolean | null
          auto_reply_enabled?: boolean | null
          auto_reply_instructions?: string | null
        }
        Update: {
          activity_keywords?: string[] | null
          auto_publish?: boolean | null
          brand_accent_color?: string | null
          brand_font?: string | null
          brand_primary_color?: string | null
          brand_secondary_color?: string | null
          company_name?: string | null
          connected_platforms?: string[] | null
          content_types?: string[]
          created_at?: string | null
          custom_image_urls?: string[] | null
          description?: string | null
          email?: string | null
          facebook_username?: string | null
          id?: string
          image_people_type?: string | null
          image_style?: string | null
          instagram_username?: string | null
          linkedin_username?: string | null
          logo_url?: string | null
          platforms?: string[]
          post_frequency?: number
          preferred_days?: string[] | null
          sector?: string
          style_example?: string | null
          style_examples?: Json | null
          tiktok_username?: string | null
          tone?: string
          twitter_username?: string | null
          updated_at?: string | null
          use_custom_images?: boolean | null
          auto_reply_enabled?: boolean | null
          auto_reply_instructions?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
