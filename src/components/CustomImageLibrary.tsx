import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Upload, X, ImagePlus, Trash2 } from "lucide-react";
import { media } from "@/lib/api";
import { toast } from "sonner";

interface CustomImageLibraryProps {
  images: string[];
  useCustomImages: boolean;
  onImagesChange: (images: string[]) => void;
  onUseCustomImagesChange: (value: boolean) => void;
}

export function CustomImageLibrary({
  images,
  useCustomImages,
  onImagesChange,
  onUseCustomImagesChange,
}: CustomImageLibraryProps) {
  const [uploading, setUploading] = useState(false);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploading(true);
    const newUrls: string[] = [];

    try {
      for (const file of Array.from(files)) {
        // Checked here for an immediate message; the API re-checks both, since
        // a browser-side check is a convenience and never a guarantee.
        if (!file.type.startsWith("image/")) {
          toast.error(`${file.name} n'est pas une image`);
          continue;
        }
        if (file.size > 5 * 1024 * 1024) {
          toast.error(`${file.name} dépasse 5 Mo`);
          continue;
        }

        // The API decides the storage path from the session, so the browser
        // cannot write into another account's media.
        const asset = await media.upload(file, "custom_image");
        newUrls.push(asset.url);
      }

      if (newUrls.length > 0) {
        onImagesChange([...images, ...newUrls]);
        toast.success(`${newUrls.length} image(s) ajoutée(s)`);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erreur lors de l'upload";
      toast.error(message);
    } finally {
      setUploading(false);
    }
  };

  const handleRemove = async (urlToRemove: string) => {
    try {
      // Media is addressed by id, not by path: resolve this URL to the asset
      // that belongs to THIS account. An id the browser could guess would let
      // it ask the API to delete someone else's file, so the lookup is scoped
      // to the session's own media by construction.
      const { media: owned } = await media.list("custom_image");
      const asset = owned.find((item) => item.url === urlToRemove);
      if (asset) await media.remove(asset.id);

      onImagesChange(images.filter((url) => url !== urlToRemove));
      toast.success("Image supprimée");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erreur lors de la suppression";
      toast.error(message);
    }
  };

  return (
    <Card className="glass-card p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <ImagePlus className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">Bibliothèque d'images personnalisées</h2>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="use-custom" className="text-sm text-muted-foreground">
            Utiliser mes images
          </Label>
          <Switch
            id="use-custom"
            checked={useCustomImages}
            onCheckedChange={onUseCustomImagesChange}
          />
        </div>
      </div>

      <p className="text-sm text-muted-foreground mb-4">
        Uploadez vos propres images (logos, photos produits, etc.) pour les utiliser dans vos posts au lieu des images générées par IA.
      </p>

      {/* Upload Area */}
      <div className="relative mb-6">
        <Input
          type="file"
          accept="image/*"
          multiple
          onChange={handleUpload}
          disabled={uploading}
          className="hidden"
          id="image-upload"
        />
        <label
          htmlFor="image-upload"
          className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-border/50 rounded-lg cursor-pointer hover:border-primary/50 transition-colors"
        >
          <Upload className="w-8 h-8 text-muted-foreground mb-2" />
          <span className="text-sm text-muted-foreground">
            {uploading ? "Upload en cours..." : "Cliquez ou glissez vos images ici"}
          </span>
          <span className="text-xs text-muted-foreground mt-1">
            PNG, JPG jusqu'à 5MB
          </span>
        </label>
      </div>

      {/* Image Grid */}
      {images.length > 0 ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {images.map((url, index) => (
            <div
              key={index}
              className="relative aspect-square rounded-lg overflow-hidden group"
            >
              <img
                src={url}
                alt={`Image ${index + 1}`}
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-background/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => handleRemove(url)}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center py-8 text-muted-foreground">
          <p className="text-sm">Aucune image uploadée</p>
        </div>
      )}

      {useCustomImages && images.length === 0 && (
        <p className="text-sm text-destructive mt-4">
          ⚠️ L'option "Utiliser mes images" est activée mais vous n'avez pas d'images. 
          Uploadez des images ou désactivez cette option.
        </p>
      )}
    </Card>
  );
}
