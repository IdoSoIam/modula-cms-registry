ALTER TABLE template_versions ADD COLUMN label_json TEXT;
ALTER TABLE template_versions ADD COLUMN description_json TEXT;
ALTER TABLE template_versions ADD COLUMN icon TEXT;
ALTER TABLE template_versions ADD COLUMN preview_image TEXT;
ALTER TABLE template_versions ADD COLUMN highlights_json TEXT;
ALTER TABLE template_versions ADD COLUMN theme_names_json TEXT;

UPDATE template_versions
SET label_json = COALESCE(label_json, (SELECT templates.label_json FROM templates WHERE templates.id = template_versions.template_id)),
    description_json = COALESCE(description_json, (SELECT templates.description_json FROM templates WHERE templates.id = template_versions.template_id)),
    icon = COALESCE(icon, (SELECT templates.icon FROM templates WHERE templates.id = template_versions.template_id)),
    preview_image = COALESCE(preview_image, (SELECT templates.preview_image FROM templates WHERE templates.id = template_versions.template_id)),
    highlights_json = COALESCE(highlights_json, (SELECT templates.highlights_json FROM templates WHERE templates.id = template_versions.template_id)),
    theme_names_json = COALESCE(theme_names_json, (SELECT templates.theme_names_json FROM templates WHERE templates.id = template_versions.template_id));
