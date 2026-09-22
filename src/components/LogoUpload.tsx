import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Upload, X, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  ACCEPTED_IMAGE_TYPES,
  buildAssetPath,
  deleteAssetByUrl,
  validateImageFile,
} from "@/lib/userAssets";

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

    const validationError = validateImageFile(file);
    if (validationError) {
      toast.error(validationError);
      return;
    }

    setUploading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Non authentifié");

      const previousUrl = currentLogoUrl;
      const fileName = buildAssetPath(session.user.id, "logo", file.type);

      const { error: uploadError } = await supabase.storage
        .from('user-assets')
        .upload(fileName, file, { contentType: file.type, upsert: true });

      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage
        .from('user-assets')
        .getPublicUrl(fileName);

      onUpload(publicUrl);
      // The bucket is public: an old logo left behind stays downloadable by
      // anyone holding its URL, and accumulates on every change.
      if (previousUrl && previousUrl !== publicUrl) await deleteAssetByUrl(previousUrl);
      toast.success("Logo téléchargé avec succès");
    } catch (error) {
      console.error('Upload error:', error);
      toast.error(error instanceof Error ? error.message : "Erreur lors du téléchargement");
    } finally {
      setUploading(false);
      // Let the user re-pick the same file after a failure.
      event.target.value = "";
    }
  };

  const handleRemove = async () => {
    const previousUrl = currentLogoUrl;
    onRemove();
    await deleteAssetByUrl(previousUrl);
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
            onClick={handleRemove}
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
          accept={ACCEPTED_IMAGE_TYPES.join(",")}
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
