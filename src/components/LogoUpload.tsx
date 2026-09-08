import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Upload, X, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { validateImageFile } from "@/lib/imageUpload";

interface LogoUploadProps {
  currentLogoUrl?: string;
  onUpload: (url: string) => void;
  onRemove: () => void;
}

export const LogoUpload = ({ currentLogoUrl, onUpload, onRemove }: LogoUploadProps) => {
  const [uploading, setUploading] = useState(false);

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Type, size and extension all validated in one place — notably this
    // rejects SVG, which the poster pipeline refuses everywhere else.
    const validation = validateImageFile(file);
    if (validation.error) {
      toast.error(validation.error);
      return;
    }

    setUploading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Non authentifié");

      // Extension comes from the validated MIME type, never from the
      // user-controlled filename.
      const fileName = `${session.user.id}/logo-${Date.now()}.${validation.extension}`;

      const { error: uploadError } = await supabase.storage
        .from('user-assets')
        .upload(fileName, file, { upsert: true, contentType: file.type });

      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage
        .from('user-assets')
        .getPublicUrl(fileName);

      onUpload(publicUrl);
      toast.success("Logo téléchargé avec succès");
    } catch (error) {
      console.error('Upload error:', error);
      toast.error("Erreur lors du téléchargement");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-4">
      {currentLogoUrl ? (
        <div className="relative inline-block">
          <img
            src={currentLogoUrl}
            alt="Logo entreprise"
            className="w-24 h-24 object-contain rounded-lg border border-border bg-muted"
          />
          <Button
            size="icon"
            variant="destructive"
            className="absolute -top-2 -right-2 h-6 w-6"
            onClick={onRemove}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <div className="w-24 h-24 rounded-lg border-2 border-dashed border-border flex items-center justify-center bg-muted/50">
          <Upload className="h-8 w-8 text-muted-foreground" />
        </div>
      )}

      <div>
        <input
          type="file"
          accept="image/*"
          onChange={handleUpload}
          className="hidden"
          id="logo-upload"
          disabled={uploading}
        />
        <label htmlFor="logo-upload">
          <Button
            variant="outline"
            size="sm"
            className="glass-card cursor-pointer"
            disabled={uploading}
            asChild
          >
            <span>
              {uploading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Téléchargement...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4 mr-2" />
                  {currentLogoUrl ? "Changer le logo" : "Ajouter un logo"}
                </>
              )}
            </span>
          </Button>
        </label>
      </div>
    </div>
  );
};
